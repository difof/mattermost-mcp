import { expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { buildClient } from "../../mattermost/client.js";
import { selectPostedFrame } from "../../events/filter.js";
import { startListener } from "../../events/listener.js";
import { useMattermost } from "./mattermost-http-fixture.js";

const id = (c) => c.repeat(26);
const me = { id: id("a"), username: "my.name" };
const channel = id("c"),
  peer = id("b"),
  denied = id("d");
const post = (key, extra = {}) => ({
  id: id(key),
  create_at: Date.now(),
  user_id: peer,
  channel_id: channel,
  message: "private text stays in Mattermost",
  type: "",
  ...extra,
});
const frame = (p, type, mentions = []) => ({
  event: "posted",
  broadcast: { channel_id: p.channel_id },
  data: { channel_type: type, post: JSON.stringify(p), mentions: JSON.stringify(mentions) },
});
const listed = (posts) => ({
  order: posts.map((p) => p.id),
  posts: Object.fromEntries(posts.map((p) => [p.id, p])),
});

it("only wakes for a real personal mention, not broadcasts, code, addresses, a longer handle or edits", () => {
  for (const message of [
    "hi @channel",
    "`@my.name` and @all",
    "send to team@my.name",
    "not @my.name.other",
    "https://example.test/@my.name",
    "[link](https://example.test/@my.name)",
  ]) {
    expect(selectPostedFrame(frame(post("x", { message }), "P", [me.id]), me)).toBeNull();
  }
  const p = post("x", { message: "Hi ＠My.Name, take a look" });
  expect(selectPostedFrame(frame(p, "G", []), me)).toBeNull();
  expect(selectPostedFrame({ ...frame(p, "P", [me.id]), event: "post_edited" }, me)).toBeNull();
  expect(selectPostedFrame(frame({ ...p, user_id: me.id }, "D"), me)).toBeNull();
  expect(selectPostedFrame(frame({ ...p, type: "system_join_channel" }, "D"), me)).toBeNull();
  expect(selectPostedFrame(frame(p, "G", [me.id]), me)).toEqual({
    kind: "mention",
    postId: p.id,
    channelId: channel,
    rootId: p.id,
    senderId: peer,
    createdAt: p.create_at,
  });
});

const fixture = useMattermost({ user: me, guardrails: { channelAllowlist: [channel] } });

it("authenticates the socket, retains live events, then fills a sequence gap from bounded allowed history", async () => {
  const f = fixture();
  const client = buildClient(f.url, 2000);
  client.setToken("test-only-personal-pat");
  const session = {
    client,
    userId: me.id,
    config: { guardrails: f.guardrails },
    call: (fn) => fn(client),
  };
  const ws = new WebSocketServer({ server: f.http, path: "/mattermost/api/v4/websocket" });
  const sockets = [],
    upgrades = [];
  ws.on("connection", (s, request) => {
    sockets.push(s);
    upgrades.push([request.url, request.headers.authorization]);
    s.send(JSON.stringify({ event: "hello", seq: 0, data: { connection_id: "synthetic" } }));
  });
  const expectMembership = (channels) => {
    f.expect("GET", "/users/me", { reply: me, fetchRedirect: "manual" });
    f.expect("GET", "/users/me/channels", {
      query: { include_deleted: true },
      reply: channels,
      fetchRedirect: "manual",
    });
  };
  let watermark = null;
  const events = new Map(),
    arrivals = [],
    states = [];
  // Cold install: pre-existing history/forbidden channels require no post reads.
  expectMembership([
    { id: channel, type: "D", last_post_at: 1 },
    { id: denied, type: "D", last_post_at: Date.now() + 10000 },
  ]);
  const stop = await startListener({
    session,
    getCheckpoint: () => watermark,
    checkpoint: async (t) => {
      watermark = t;
    },
    enqueue: async (e) => {
      arrivals.push(e.postId);
      events.set(e.postId, e);
    },
    onStatus: (s) => states.push(s),
  });
  try {
    await vi.waitFor(() => expect(states).toContain("connected"));
    expect(watermark).toBeGreaterThan(0);
    const live = post("e"),
      missed = post("f"),
      old = post("g", { create_at: watermark - 1 });
    sockets[0].send(JSON.stringify({ ...frame(post("h", { channel_id: denied }), "D"), seq: 1 }));
    sockets[0].send(JSON.stringify({ ...frame(live, "D"), seq: 2 }));
    await vi.waitFor(() => expect(arrivals).toEqual([live.id]));
    expectMembership([
      { id: denied, type: "D", last_post_at: Date.now() },
      { id: channel, type: "D", last_post_at: Date.now() },
    ]);
    f.expect("GET", "/channels/" + channel + "/posts", {
      query: { per_page: 60, skipFetchThreads: true },
      reply: listed([missed, live]),
      fetchRedirect: "manual",
    });
    f.expect("GET", "/channels/" + channel + "/posts", {
      query: { per_page: 60, skipFetchThreads: true, before: live.id },
      reply: listed([old]),
      fetchRedirect: "manual",
    });
    sockets[0].send(JSON.stringify({ event: "typing", seq: 4 })); // seq 3 was lost
    await vi.waitFor(() => expect(states.filter((s) => s === "connected")).toHaveLength(2), {
      timeout: 4000,
    });
    expect([...events.keys()]).toEqual([live.id, missed.id]);
    expect(arrivals.filter((x) => x === live.id)).toHaveLength(2); // durable outbox keys both sources by post ID
    expect(upgrades).toEqual(
      Array(2).fill(["/mattermost/api/v4/websocket", "Bearer test-only-personal-pat"]),
    );
  } finally {
    await stop();
    for (const s of ws.clients) s.terminate();
    await new Promise((resolve) => ws.close(resolve));
  }
});
