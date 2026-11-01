import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildClient } from "../mattermost/client.js";
import { cachedMessagesTool } from "../tools/cached-messages.js";
import { selectPost } from "./filter.js";
import { openCache } from "./cache.js";
import { postAccess } from "./post-presentation.js";
import { startEvents } from "./index.js";
vi.mock("./listener.js", () => ({ startListener: () => async () => {} }));

const id = (c) => c.repeat(26),
  channel = id("c"),
  me = { id: id("m"), username: "fixture-reader" };
let dir, cache, session, post, getPost;
const pull = (args) => cachedMessagesTool.handler(args, { session });
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mm-post-view-"));
  cache = await openCache(join(dir, "db"));
  session = {
    cache,
    userId: me.id,
    client: buildClient("https://fixture.invalid", 3000),
    config: { cacheVerifyPosts: true, guardrails: { teamAllowlist: [], channelAllowlist: [] } },
  };
  post = {
    id: id("p"),
    channel_id: channel,
    user_id: id("s"),
    create_at: Date.now() - 100,
    message: "cached private bytes",
    file_ids: [id("f")],
  };
  cache.apply(selectPost(post, "P", me));
  getPost = vi.fn(() => Response.json(post));
  vi.stubGlobal("fetch", async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/users/me")) return Response.json(me);
    if (path.endsWith("/users/me/channels")) return Response.json([{ id: channel, type: "P" }]);
    if (path.endsWith("/channels/" + channel + "/posts"))
      return Response.json({ order: [], posts: {} });
    if (path.endsWith("/posts/" + post.id)) return getPost();
    throw new Error("unexpected fixture route");
  });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  cache?.close();
  await rm(dir, { recursive: true, force: true });
});

it("revalidates both a new claim and its receipt against the post's current same-version view", async () => {
  const key = { request_id: randomUUID(), unread_only: true };
  getPost.mockReturnValueOnce(Response.json({}, { status: 503 }));
  await expect(pull(key)).rejects.toThrow(/verify Mattermost post/);
  expect(cache.list().messages[0].readCount).toBe(0);
  post = { ...post, message: "@fixture-reader masked", file_ids: [] };
  const first = await pull(key);
  expect(first.messages).toMatchObject([
    { message: "@fixture-reader masked", fileIds: [], isMention: true, readCount: 1 },
  ]);
  expect(cache.list().messages[0].message).toBe(post.message);
  // A bulk hook can render differently from a per-post hook. An older list
  // response at the SAME post timestamp cannot restore a known hidden body.
  cache.applyBatch([selectPost({ ...post, message: "old bulk body" }, "P", me)], {
    authoritative: true,
  });
  expect(cache.list().messages[0].message).toBe(post.message);
  expect(first.messages[0]).not.toHaveProperty("verifiedView");
  getPost.mockReturnValueOnce(Response.json({ ...post, id: id("x") })); // wrong response never authenticates a row
  await expect(pull(key)).rejects.toThrow(/Unexpected post/);
  getPost.mockReturnValueOnce(Response.json({}, { status: 503 }));
  await expect(pull(key)).rejects.toThrow(/verify Mattermost post/);
  post = { ...post, message: "further masked" };
  expect(await pull(key)).toMatchObject({
    replayed: true,
    messages: [{ message: "further masked", isMention: false, readCount: 1 }],
  });
  post = { ...post, type: "burn_on_read" };
  expect(await pull(key)).toMatchObject({ replayed: true, messages: [] });
  expect(cache.list().messages).toEqual([]);
});

it("does not erase a newer incarnation using an older denial or expose a post absent upstream", async () => {
  const access = { me, allows: () => true };
  const checker = postAccess(session, cache, access);
  const [{ postId, channelId }] = cache.list().messages;
  let start, release;
  const began = new Promise((r) => {
      start = r;
    }),
    hold = new Promise((r) => {
      release = r;
    });
  getPost.mockImplementationOnce(async () => {
    start();
    await hold;
    return Response.json({}, { status: 404 });
  });
  const verified = checker.check([{ postId, channelId }]);
  await began;
  cache.purgeChannel(channel);
  cache.apply(selectPost({ ...post, message: "new incarnation" }, "P", me));
  release();
  await verified;
  expect(checker.allows({ postId, channelId })).toBe(false);
  expect(cache.list().messages[0].message).toBe("new incarnation");
  getPost.mockReturnValueOnce(Response.json({}, { status: 403 }));
  expect((await pull({})).messages).toEqual([]);
  expect(cache.list().messages).toEqual([]);
});

it("fails closed per post for callback metadata, and invalidates approval on subsequent edits", async () => {
  const access = { me, allows: () => true };
  const checker = postAccess(session, cache, access),
    [row] = cache.list().messages;
  getPost.mockReturnValueOnce(Response.json({}, { status: 503 }));
  await checker.check([row], { partial: true });
  expect(checker.allows(row)).toBe(false);
  await checker.check([row], { partial: true });
  expect(checker.allows(row)).toBe(true);
  cache.apply(selectPost({ ...post, message: "newer", update_at: post.create_at + 1 }, "P", me));
  expect(checker.allows(row)).toBe(false);
  post = { ...post, type: "system_join_channel", update_at: post.create_at + 1 };
  await checker.check([row], { partial: true });
  expect(checker.allows(row)).toBe(false);
  expect(cache.list().messages).toEqual([]);
});

it("withholds callback metadata for a masked-away post but delivers the next verified match", async () => {
  const hook = "https://callback.invalid/fake",
    sent = [],
    originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (url, options) => {
    if (String(url) !== hook) return originalFetch(url, options);
    sent.push(JSON.parse(options.body));
    return Promise.resolve(new Response(null, { status: 204 }));
  });
  const config = { ...session.config, url: "https://fixture.invalid" };
  const stop = await startEvents({
    config,
    session,
    stateDir: join(dir, "events"),
    targets: {
      resolve: () => ({ kind: "webhook", url: hook, headers: {} }),
    },
  });
  try {
    session.subscriptions.register({ callback_url: hook, ttl_seconds: 30 }, { channelId: channel });
    const at = Date.now();
    post = { ...post, create_at: at };
    session.cache.apply(selectPost(post, "P", me));
    post = { ...post, type: "burn_on_read" };
    session.subscriptions.wake();
    await vi.waitFor(() => expect(session.cache.list().messages).toEqual([]));
    expect(sent).toEqual([]);
    post = { ...post, id: id("k"), type: "", create_at: Date.now(), message: "ordinary" };
    session.cache.apply(selectPost(post, "P", me));
    session.subscriptions.wake();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].postId).toBe(post.id);
    expect(sent[0]).not.toHaveProperty("message");
    expect(session.cache.list().messages[0].readCount).toBe(0);
  } finally {
    await stop();
  }
});
