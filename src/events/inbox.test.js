import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openCache } from "./cache.js";
import { receiptKey } from "./inbox.js";

it("retries the original page across a restart without double-counting or retaining revoked bodies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "inbox-retry-")),
    file = join(dir, "cache.sqlite3");
  const id = (char) => char.repeat(26),
    now = Date.now();
  const record = (pid, ch, when) => ({
    postId: id(pid),
    rootId: id(pid),
    channelId: id(ch),
    senderId: id("u"),
    createdAt: when,
    updatedAt: when,
    direction: "incoming",
    channelType: "P",
    message: "fixture",
    fileIds: [],
  });
  const opts = { unreadOnly: true, limit: 2 },
    key = receiptKey("fixture", "caller", opts);
  let db = await openCache(file);
  try {
    const top = record("a", "a", now),
      second = record("b", "b", now - 1),
      third = record("c", "c", now - 2);
    db.applyBatch([top, second, third]);
    const first = db.pullPage(opts, () => true, key).page;
    expect(first.messages.map((m) => m.postId)).toEqual([top.postId, second.postId]);
    expect(first.nextCursor).toBeTruthy();
    db.close();
    db = await openCache(file);
    expect(db.pullPage(opts, () => false, key)).toEqual({
      unverified: [top.channelId, second.channelId],
    });
    db.apply({ ...top, message: "edited", updatedAt: now + 1 });
    const retry = db.pullPage(opts, () => true, key).page;
    expect(retry.replayed).toBe(true);
    expect(retry.messages.map((m) => [m.message, m.readCount])).toEqual([
      ["edited", 1],
      ["fixture", 1],
    ]);
    expect(db.inboxCounts([top.channelId, second.channelId, third.channelId])).toEqual({
      retained: 3,
      unread: 1,
    });
    expect(() =>
      db.pullPage({ ...opts, limit: 1 }, () => true, { ...key, signature: "different" }),
    ).toThrow(/different/);
    db.purgeChannel(second.channelId);
    db.apply(second); // New membership, same upstream post ID, different cache incarnation.
    const restricted = db.pullPage(opts, () => true, key).page;
    expect(restricted.messages.map((m) => m.postId)).toEqual([top.postId]);
    expect(restricted.nextCursor).toBeNull();
    expect(restricted.cursorInvalidated).toBe(true);
    expect(db.list().messages.find((m) => m.postId === second.postId).readCount).toBe(0);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("keeps a mixed replay page within the aggregate budget after its short posts grow", async () => {
  const dir = await mkdtemp(join(tmpdir(), "inbox-replay-budget-"));
  const now = Date.now(),
    db = await openCache(join(dir, "scope.sqlite3")),
    id = (i) => String(i).padStart(26, "0");
  try {
    const rows = Array.from({ length: 80 }, (_, i) => ({
      postId: id(i),
      rootId: id(i),
      channelId: id(500),
      senderId: id(501),
      createdAt: now - i,
      updatedAt: now,
      channelType: "P",
      direction: "incoming",
      message: i === 79 ? "x".repeat(103000) : "",
      fileIds: [],
    }));
    db.applyBatch(rows);
    const opts = { limit: 100 },
      key = receiptKey("budget", null, opts);
    const first = db.pullPage(opts, () => true, key).page;
    expect(first.messages).toHaveLength(80);
    db.applyBatch(
      rows.slice(0, -1).map((r) => ({ ...r, message: "y".repeat(1400), updatedAt: now + 1 })),
    );
    const replay = db.pullPage(opts, () => true, key).page;
    expect(replay.messages).toHaveLength(80);
    expect(Buffer.byteLength(JSON.stringify(replay))).toBeLessThanOrEqual(128 * 1024);
    expect(replay.messages.every((m) => m.readCount === 1)).toBe(true);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
