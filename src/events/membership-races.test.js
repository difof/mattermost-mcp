import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { buildClient } from "../mattermost/client.js";
import { openCache } from "./cache.js";
import { openDirectory } from "./directory.js";
import { createDirectoryRefresh } from "./directory-refresh.js";
import { cacheAccess } from "./cache-access.js";
import { recoverPosts } from "./recovery.js";

const id = (c) => c.repeat(26);
const a = { id: id("a"), type: "P" },
  b = { id: id("b"), type: "G" };
const me = { id: id("m"), username: "fixture" };
const raw = {
  id: id("p"),
  user_id: me.id,
  channel_id: b.id,
  create_at: 90,
  update_at: 90,
  message: "fixture",
};
const record = {
  postId: raw.id,
  rootId: raw.id,
  senderId: me.id,
  channelId: b.id,
  createdAt: 90,
  updatedAt: 90,
  message: raw.message,
  channelType: b.type,
  direction: "outgoing",
};
const latch = () => {
  let release;
  const held = new Promise((r) => {
    release = r;
  });
  return { release, held };
};
let close;
afterEach(async () => {
  await close?.();
  vi.unstubAllGlobals();
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "membership-grants-"));
  const cache = await openCache(join(dir, "db"), { now: () => 100 });
  const session = {
    client: buildClient("https://fixture.invalid", 1000),
    userId: me.id,
    config: { guardrails: { teamAllowlist: [], channelAllowlist: [] } },
  };
  cache.directory = openDirectory(cache);
  const directory = createDirectoryRefresh(session, cache);
  cache.refreshMembership = (signal) => directory.refresh(signal, false);
  const upstream = { channels: [a, b], membershipCalls: 0 };
  vi.stubGlobal("fetch", async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/users/me")) return Response.json(me);
    if (path.endsWith("/channels")) {
      const selected = upstream.channels;
      upstream.membershipCalls++;
      const delay = upstream.delay;
      delete upstream.delay;
      if (delay) {
        delay.began.release();
        await delay.response.held;
      }
      return Response.json(selected);
    }
    return upstream.postList(url);
  });
  close = async () => {
    await directory.close();
    cache.close();
    await rm(dir, { recursive: true, force: true });
  };
  return { cache, session, directory, upstream };
}
it("does not prune newly joined posts or their read counts from an obsolete pull", async () => {
  const { cache, session, directory, upstream } = await setup();
  upstream.channels = [a];
  await directory.refresh();
  const delay = (upstream.delay = { began: latch(), response: latch() });
  const old = cacheAccess(session, cache);
  await delay.began.held;
  upstream.channels = [a, b];
  directory.invalidate();
  const fresh = directory.refresh().then(() => {
    cache.apply(record);
    expect(cache.pullPage({}, () => true).page.messages[0].readCount).toBe(1);
  });
  // The old HTTP response still carries only A, even though B has since joined.
  delay.response.release();
  await Promise.all([old, fresh]);
  expect(cache.list().messages).toMatchObject([{ channelId: b.id, readCount: 1 }]);
});
it("fences a pre-removal history response even after the same channel is rejoined", async () => {
  const { cache, session, directory, upstream } = await setup();
  const initial = await directory.refresh();
  cache.apply(record);
  const began = latch(),
    response = latch();
  upstream.postList = async () => {
    began.release();
    await response.held;
    return Response.json({ order: [raw.id], posts: { [raw.id]: raw } });
  };
  const replay = recoverPosts({
    session,
    me,
    channels: new Map([[b.id, b]]),
    since: 90 - 1,
    until: 100,
    current: initial.isCurrent,
    signal: new AbortController().signal,
    cache: { ...cache, enqueueBatch: (rows) => cache.applyBatch(rows, { authoritative: true }) },
  });
  await began.held;
  upstream.channels = [a];
  await directory.refresh();
  expect(cache.list().messages).toEqual([]);
  upstream.channels = [a, b];
  const rejoined = await directory.refresh();
  expect(rejoined.isCurrent(b.id)).toBe(true);
  response.release();
  await replay;
  expect(cache.list().messages).toEqual([]);
});
it("refreshes equal-version authoritative content without undoing newer edits or resetting reads", async () => {
  const { cache } = await setup();
  cache.apply(record);
  cache.pullPage({}, () => true);
  cache.applyBatch([{ ...record, message: "masked" }], { authoritative: true });
  cache.apply(record);
  expect(cache.list().messages).toMatchObject([{ message: "masked", readCount: 1 }]);
  cache.apply({ ...record, updatedAt: 92, message: "newer" });
  cache.applyBatch([record], { authoritative: true });
  expect(cache.list().messages).toMatchObject([{ message: "newer", readCount: 1 }]);
});
it("never shares an already in-flight permission lookup with a later caller", async () => {
  const { directory, upstream } = await setup();
  const delay = (upstream.delay = { began: latch(), response: latch() });
  const before = directory.refresh();
  await delay.began.held;
  upstream.channels = [a];
  const after = directory.refresh();
  delay.response.release();
  const [one, two] = await Promise.all([before, after]);
  expect(one.channels.has(b.id)).toBe(true);
  expect(two.channels.has(b.id)).toBe(false);
  expect(one.isCurrent(b.id)).toBe(false);
});
it("uses a short cursor lease only on a healthy, unchanged directory", async () => {
  const { directory, upstream } = await setup();
  const first = await directory.page({ limit: 1 }, () => true);
  expect(first.nextCursor).toBeTruthy();
  expect(
    (await directory.page({ limit: 1, cursor: first.nextCursor }, () => true)).conversations[0].id,
  ).toBe(b.id);
  expect(upstream.membershipCalls).toBe(1);
  upstream.channels = [a];
  directory.invalidate(b.id);
  expect(
    (await directory.page({ limit: 1, cursor: first.nextCursor }, () => true)).conversations,
  ).toEqual([]);
  expect(upstream.membershipCalls).toBe(2);
  upstream.channels = [a, b];
  const again = await directory.page({ limit: 1 }, () => true);
  upstream.channels = [a];
  expect(
    (await directory.page({ limit: 1, cursor: again.nextCursor }, () => false)).conversations,
  ).toEqual([]);
});
