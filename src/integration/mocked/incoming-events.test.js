import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { buildClient } from "../../mattermost/client.js";
import { openCache } from "../../events/cache.js";
import { selectPostedFrame } from "../../events/filter.js";
import { openDirectory } from "../../events/directory.js";
import { createDirectoryRefresh } from "../../events/directory-refresh.js";
import { startListener } from "../../events/listener.js";
import { useMattermost } from "./mattermost-http-fixture.js";

const id = (c) => c.repeat(26);
const me = { id: id("a"), username: "my.name" };
const channel = id("c"),
  peer = id("b"),
  denied = id("d"),
  newGroup = id("n");
const post = (key, extra = {}) => ({
  id: id(key),
  create_at: Date.now() - 10000,
  user_id: peer,
  channel_id: channel,
  message: "original content",
  type: "",
  ...extra,
});
const frame = (p, event = "posted", type = "P") => ({
  event,
  broadcast: { channel_id: p.channel_id },
  data: { ...(type ? { channel_type: type } : {}), post: JSON.stringify(p) },
});
const listed = (posts) => ({
  order: posts.map((p) => p.id),
  posts: Object.fromEntries(posts.map((p) => [p.id, p])),
});

it("keeps inbound and outbound conversations including file-only replies; filters system notices and private props", () => {
  const base = post("x", {
    root_id: id("r"),
    message: "",
    file_ids: [id("f")],
    user_id: me.id,
    props: { secret: "never cache" },
    metadata: { embeds: ["not part of the post"] },
  });
  expect(selectPostedFrame(frame(base, "posted", "G"), me)).toEqual({
    postId: base.id,
    channelId: channel,
    createdAt: base.create_at,
    updatedAt: base.create_at,
    senderId: me.id,
    rootId: id("r"),
    direction: "outgoing",
    message: "",
    fileIds: [id("f")],
    channelType: "G",
    isMention: false,
  });
  const incoming = post("y", { message: "Hi ＠My.Name!" });
  expect(selectPostedFrame(frame(incoming, "post_edited", "O"), me)).toMatchObject({
    direction: "incoming",
    isMention: true,
  });
  expect(
    selectPostedFrame(frame({ ...incoming, message: "see `@my.name` and @channel" }), me),
  ).toMatchObject({ isMention: false });
  expect(selectPostedFrame(frame({ ...base, type: "system_join_channel" }), me)).toBeNull();
  expect(selectPostedFrame(frame({ ...base, type: "burn_on_read" }), me)).toBeNull();
  const deletedAt = Date.now();
  expect(
    selectPostedFrame(frame({ ...base, delete_at: deletedAt }, "post_deleted", null), me),
  ).toEqual({
    postId: base.id,
    channelId: channel,
    createdAt: base.create_at,
    updatedAt: deletedAt,
    deleted: true,
  });
});

const fixture = useMattermost({ user: me, guardrails: { channelAllowlist: [channel, newGroup] } });
it("reconciles the full rolling window while receiving live posts, fixes offline edits/deletes and purges revoked channels", async () => {
  const f = fixture(),
    client = buildClient(f.url, 2000);
  client.setToken("test-only-personal-pat");
  const session = {
    client,
    userId: me.id,
    config: { guardrails: f.guardrails },
    call: (fn) => fn(client),
  };
  const retentionHours = 72;
  const dir = await mkdtemp(join(tmpdir(), "mm-cache-recovery-")),
    cache = await openCache(join(dir, "messages.sqlite"), { retentionHours });
  const ws = new WebSocketServer({ server: f.http, path: "/mattermost/api/v4/websocket" });
  const sockets = [],
    upgrades = [],
    states = [];
  ws.on("connection", (s, request) => {
    sockets.push(s);
    upgrades.push(request.headers.authorization);
    s.send(JSON.stringify({ event: "hello", seq: 0, data: { connection_id: "test" } }));
  });
  const group = [
    { id: channel, type: "P", last_post_at: Date.now() },
    { id: denied, type: "D", last_post_at: Date.now() },
  ];
  const member = (channels, account = me) => {
    f.expect("GET", "/users/me", { reply: account });
    f.expect("GET", "/users/me/channels", { query: { include_deleted: true }, reply: channels });
  };
  const page = (posts, before, extra = {}) =>
    f.expect("GET", "/channels/" + channel + "/posts", {
      query: { per_page: 60, skipFetchThreads: true, ...(before ? { before } : {}) },
      reply: listed(posts),
      ...extra,
    });
  const old = post("z", { create_at: Date.now() - retentionHours * 3600000 - 3000 });
  const original = post("e"),
    laterDeleted = post("g", { create_at: original.create_at - 5 }),
    mine = post("m", { user_id: me.id, create_at: Date.now() - 60 * 3600000 });
  const live = post("v", { edit_at: Date.now(), id: original.id, message: "latest live edit" });
  let release,
    entered = false;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  member(group);
  page([original, laterDeleted], null, {
    inspectBody: async () => {
      entered = true;
      await hold;
    },
  });
  page([laterDeleted, mine, old], original.id);
  cache.directory = openDirectory(cache);
  const directory = createDirectoryRefresh(session, cache);
  const stop = await startListener({
    refreshDirectory: directory.refresh,
    invalidateDirectory: directory.invalidate,
    session,
    ...cache,
    enqueue: cache.apply,
    enqueueBatch: cache.applyBatch,
    onStatus: (s) => states.push(s),
  });
  const rows = () => cache.list({}).messages;
  try {
    await vi.waitFor(() => expect(entered).toBe(true));
    sockets[0].send(JSON.stringify({ ...frame(post("u", { channel_id: denied })), seq: 1 }));
    sockets[0].send(JSON.stringify({ ...frame(live, "post_edited", null), seq: 2 }));
    await vi.waitFor(() => expect(rows().map((p) => p.message)).toEqual(["latest live edit"]));
    release();
    await vi.waitFor(() => expect(states).toContain("connected"));
    expect(rows().find((r) => r.postId === original.id)?.message).toBe("latest live edit");
    expect(rows().find((r) => r.postId === mine.id)?.direction).toBe("outgoing");
    expect(rows().map((r) => r.postId)).not.toContain(old.id);
    const newDm = post("h", { root_id: id("t"), file_ids: [id("i")], message: "" });
    sockets[0].send(JSON.stringify({ ...frame(newDm), seq: 3 }));
    await vi.waitFor(() =>
      expect(rows().find((row) => row.postId === newDm.id)?.fileIds).toEqual([id("i")]),
    );
    sockets[0].send(JSON.stringify({ ...frame(newDm, "post_deleted", null), seq: 4 }));
    await vi.waitFor(() => expect(rows()).toHaveLength(3));
    const missed = post("j", { message: "new while disconnected" });
    member(group);
    page([
      missed,
      { ...original, edit_at: Date.now() + 2, message: "edited while disconnected" },
      mine,
      old,
    ]);
    f.expect("GET", "/posts/" + laterDeleted.id, { status: 404, reply: {} });
    sockets[0].send(JSON.stringify({ event: "typing", seq: 6 })); // event 5 was lost
    await vi.waitFor(() => expect(states.filter((x) => x === "connected")).toHaveLength(2), {
      timeout: 4500,
    });
    expect(
      rows()
        .map((r) => r.postId)
        .sort(),
    ).toEqual([original.id, mine.id, missed.id].sort());
    expect(rows().find((r) => r.postId === original.id).message).toBe("edited while disconnected");
    // Channel and profile changes use REST values, never the event payload,
    // and don't restart the entire history scan for a rename.
    member([{ ...group[0], display_name: "Renamed channel" }, group[1]]);
    sockets[1].send(
      JSON.stringify({
        event: "channel_updated",
        seq: 1,
        data: { channel: { id: denied, display_name: "untrusted" } },
      }),
    );
    await vi.waitFor(() =>
      expect(cache.directory.list().conversations).toMatchObject([
        { id: channel, displayName: "Renamed channel" },
      ]),
    );
    member(group, { ...me, username: "renamed.user" });
    sockets[1].send(
      JSON.stringify({
        event: "user_updated",
        seq: 2,
        data: { user: { id: me.id, username: "untrusted" } },
      }),
    );
    await vi.waitFor(() => expect(cache.directory.list().account.username).toBe("renamed.user"));
    expect(sockets).toHaveLength(2);
    member([]);
    sockets[1].send(
      JSON.stringify({
        event: "user_removed",
        seq: 3,
        broadcast: { user_id: me.id },
        data: { channel_id: channel },
      }),
    );
    await vi.waitFor(() => expect(rows()).toHaveLength(0));
    await vi.waitFor(() => expect(states.filter((x) => x === "connected")).toHaveLength(3), {
      timeout: 4500,
    });
    expect(cache.directory.list().conversations).toEqual([]);
    // Joining a quiet group must populate the directory without any tool pull
    // or a recent post. Only the REST-confirmed group belongs to this account.
    member([{ id: newGroup, type: "G", display_name: "Quiet group", last_post_at: 0 }]);
    f.expect("GET", "/channels/" + newGroup + "/posts", {
      query: { per_page: 60, skipFetchThreads: true },
      reply: listed([]),
    });
    sockets[2].send(
      JSON.stringify({
        event: "group_added",
        seq: 1,
        broadcast: { user_id: me.id },
        data: { channel_id: denied },
      }),
    );
    await vi.waitFor(() => expect(states.filter((x) => x === "connected")).toHaveLength(4), {
      timeout: 4500,
    });
    expect(cache.directory.list().conversations).toMatchObject([
      { id: newGroup, type: "G", displayName: "Quiet group", lastPostAt: 0 },
    ]);
    expect(rows()).toHaveLength(0);
    expect(upgrades).toEqual(Array(4).fill("Bearer test-only-personal-pat"));
  } finally {
    release();
    await stop();
    await directory.close();
    for (const s of ws.clients) s.terminate();
    await new Promise((resolve) => ws.close(resolve));
    cache.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 12000);
