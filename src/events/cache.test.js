import { afterEach, expect, it } from "vitest";
import { mkdtempSync, statSync, rmSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCache, RETENTION_MS } from "./cache.js";

const id = (n) => String(n).padStart(26, "0");
const start = 1730000000000;
const post = (n, overrides = {}) => ({
  postId: id(n),
  channelId: id(101),
  rootId: id(n),
  senderId: id(201),
  createdAt: start + n,
  updatedAt: start + n,
  channelType: "D",
  direction: "incoming",
  isMention: false,
  message: "example " + n,
  fileIds: [],
  ...overrides,
});
const dirs = [],
  connections = [];
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "mm-sqlite-"));
  dirs.push(dir);
  const file = join(dir, "private", "messages.sqlite");
  let time = start + 1000,
    db;
  async function reopen() {
    if (db) {
      db.close();
      connections.splice(connections.indexOf(db), 1);
    }
    db = await openCache(file, { now: () => time });
    connections.push(db);
    return db;
  }
  return {
    file,
    db: await reopen(),
    reopen,
    setTime: (t) => {
      time = t;
    },
  };
}
afterEach(() => {
  for (const c of connections.splice(0)) c.close();
  for (const p of dirs.splice(0)) rmSync(p, { force: true, recursive: true });
});

it("persists original creation times, monotonic cursor and terminal tombstones; erases expired content", async () => {
  const h = await fixture();
  let c = h.db;
  expect(c.getCheckpoint()).toBeNull();
  expect(statSync(h.file).mode & 0o777).toBe(0o600);
  expect(statSync(join(h.file, "..")).mode & 0o777).toBe(0o700);
  const original = post(1, { message: "sensitive-original-content-12345" }),
    edited = { ...original, message: "sensitive-edited-content-12345", updatedAt: start + 900 };
  expect(c.apply(original)).toBe(true);
  expect(c.apply(edited)).toBe(false);
  expect(c.apply(original)).toBe(false);
  expect(c.list().messages[0].message).toBe(edited.message);
  c.checkpoint(start + 880);
  c.checkpoint(start + 10);
  c = await h.reopen();
  expect(c.getCheckpoint()).toBe(start + 880);
  const keep = post(2, {
    direction: "outgoing",
    message: "recent-heartbeat-private-payload",
    fileIds: [id(501)],
  });
  c.apply(keep);
  c.apply({ ...original, deleted: true, updatedAt: start + 999 });
  expect(c.apply({ ...edited, updatedAt: start + 1001 })).toBe(false);
  expect(c.list().messages.map((p) => p.postId)).toEqual([keep.postId]);
  expect(readFileSync(h.file).includes(Buffer.from(edited.message))).toBe(false);
  h.setTime(keep.createdAt + RETENTION_MS);
  c = await h.reopen();
  expect(c.list()).toEqual({ messages: [], nextCursor: null });
  expect(c.apply({ ...keep, updatedAt: keep.createdAt + RETENTION_MS })).toBe(false);
  expect(readFileSync(h.file).includes(Buffer.from(keep.message))).toBe(false);
});
it("filters before keyset paging and preserves insertion cursors across edits, rollback, pruning and restart", async () => {
  const h = await fixture();
  let c = h.db;
  const common = {
    channelId: id(101),
    senderId: id(201),
    channelType: "P",
    direction: "incoming",
    isMention: true,
    createdAt: start + 15,
    updatedAt: start + 15,
  };
  const base = post(1, common);
  c.apply(base);
  const seq = c.highWatermark();
  const wanted = post(2, common),
    last = post(3, common);
  expect(
    c.applyBatch([
      wanted,
      last,
      wanted,
      post(4, { ...common, isMention: false }),
      post(5, { ...common, direction: "outgoing" }),
    ]),
  ).toHaveLength(4);
  const filters = {
    channelId: common.channelId,
    senderId: common.senderId,
    channelType: "P",
    direction: "incoming",
    isMention: true,
    since: common.createdAt,
  };
  const first = c.list({ ...filters, limit: 2 });
  expect(first.messages.map((x) => x.postId)).toEqual([last.postId, wanted.postId]);
  expect(c.list({ ...filters, limit: 2, cursor: first.nextCursor })).toEqual({
    messages: [base],
    nextCursor: null,
  });
  expect(() => c.list({ cursor: "bad!" })).toThrow("cursor");
  const next = c.nextMatching(filters, seq, common.createdAt);
  expect(next.record).toEqual(wanted);
  c.apply({ ...wanted, message: "Edited", updatedAt: start + 99 });
  expect(c.nextMatching(filters, next.seq, common.createdAt).record).toEqual(last);
  const high = c.highWatermark();
  expect(() => c.applyBatch([post(8), { postId: "oops" }])).toThrow();
  expect(c.highWatermark()).toBe(high);
  h.setTime(start + RETENTION_MS + 9999);
  expect(c.prune()).toBe(5);
  c = await h.reopen();
  expect(c.highWatermark()).toBe(high);
  c.apply(post(10, { createdAt: start + RETENTION_MS, updatedAt: start + RETENTION_MS }));
  expect(c.highWatermark()).toBeGreaterThan(high);
});
it("purges revoked channels and reconciles offline deletions without deleting newer edits", async () => {
  const { db: c } = await fixture();
  const a = post(1),
    b = post(2),
    other = post(3, { channelId: id(102) });
  c.applyBatch([a, b, other]);
  const before = start + 100;
  expect(c.cachedIds(a.channelId, start, before).sort()).toEqual([a.postId, b.postId]);
  c.apply({ ...b, updatedAt: before + 1 });
  c.reconcileMissing(a.channelId, [a.postId, b.postId], before);
  c.retainChannels(new Set([a.channelId]));
  expect(c.list().messages.map((p) => p.postId)).toEqual([b.postId]);
  expect(c.apply(a)).toBe(false);
  c.purgeChannel(a.channelId);
  expect(c.list().messages).toEqual([]);
});
it("caps serialized results, says when a message was truncated, and resumes at the next post", async () => {
  const { db: c } = await fixture();
  const large = post(11, { message: "\u0001🚀".repeat(30000) }),
    ordinary = post(2);
  c.applyBatch([ordinary, large]);
  const page = c.list();
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(128 * 1024);
  expect(page.messages[0]).toMatchObject({
    messageTruncated: true,
    messageBytes: Buffer.byteLength(large.message),
    postId: large.postId,
  });
  expect(large.message.startsWith(page.messages[0].message)).toBe(true);
  expect(c.list({ cursor: page.nextCursor }).messages).toEqual([ordinary]);
});
it("refuses an unsafe existing database or symlink instead of using it", async () => {
  const root = mkdtempSync(join(tmpdir(), "mm-private-"));
  dirs.push(root);
  const other = join(root, "other");
  writeFileSync(other, "not a database", { mode: 0o644 });
  await expect(openCache(other)).rejects.toThrow("owner-only");
  const link = join(root, "link");
  symlinkSync(other, link);
  await expect(openCache(link)).rejects.toThrow();
});
it("removes a whole thread on one root-deleted frame, even for an expired root, and blocks a replayed reply", async () => {
  const { db: c } = await fixture();
  const root = post(5, { createdAt: start - RETENTION_MS - 1 }),
    one = post(6, { rootId: root.postId }),
    two = post(7, { rootId: root.postId });
  c.applyBatch([root, one, two]);
  expect(c.list().messages.map((r) => r.postId)).toEqual([two.postId, one.postId]);
  c.apply({ ...root, deleted: true });
  expect(c.list().messages).toEqual([]);
  expect(c.apply({ ...one, updatedAt: start + 1200 })).toBe(false);
  expect(c.apply(post(8, { rootId: root.postId }))).toBe(false);
});
