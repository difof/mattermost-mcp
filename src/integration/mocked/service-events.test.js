import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebSocketServer } from "ws";
import { expect, it, vi } from "vitest";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}
async function closeServer(server) {
  if (!server.listening) return;
  const closed = once(server, "close");
  server.close();
  server.closeAllConnections();
  await closed;
}

const token = "fixture-loopback-mcp-token-1234567890123456";
const pat = "fixture-mattermost-pat";
const cli = fileURLToPath(new URL("../../index.js", import.meta.url));

async function startService(env) {
  const reservation = createServer();
  const port = await listen(reservation);
  await closeServer(reservation);
  const child = spawn(process.execPath, [cli, "serve"], {
    env: { ...env, MM_HTTP_PORT: String(port), MM_HTTP_TOKEN: token },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let diagnostic = "";
  child.stderr.on("data", (chunk) => {
    diagnostic += chunk.toString();
  });
  const client = new Client({ name: "cache-check", version: "1" });
  const stop = async () => {
    await client.close();
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  };
  try {
    await vi.waitFor(() => expect(diagnostic).toContain("serving MCP at"), { timeout: 5000 });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://127.0.0.1:" + port + "/mcp"), {
        requestInit: { headers: { authorization: "Bearer " + token } },
      }),
    );
    return { client, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
async function call(client, name, args = {}, meta) {
  const r = await client.callTool({ name, arguments: args, _meta: meta });
  if (r.isError) throw new Error(r.content[0].text);
  return JSON.parse(r.content[0].text);
}

const list = (client, args) => call(client, "list_cached_messages", args);

it("caches received and sent posts locally and delivers only an explicitly subscribed match", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mattermost-cache-"));
  const id = (char) => char.repeat(26);
  const me = { id: id("a"), username: "operator" },
    peer = id("b"),
    dm = id("c"),
    room = id("d");
  const at = Date.now();
  const post = (key, channel_id, user_id, create_at, message) => ({
    id: id(key),
    channel_id,
    user_id,
    create_at,
    update_at: create_at,
    message,
    type: "",
    root_id: "",
  });
  const retained = post("e", dm, peer, at - 3600000, "retained DM"),
    expired = post("f", dm, peer, at - 49 * 3600000, "expired");
  const incoming = post("g", room, peer, at, "ordinary channel message"),
    sent = post("h", dm, me.id, at + 1, "sent from another client");
  let channels = [
    { id: dm, type: "D", team_id: "", last_post_at: at },
    { id: room, type: "P", team_id: id("t"), last_post_at: at },
  ];
  const history = new Map([
    [dm, [retained, expired]],
    [room, []],
  ]);
  let failMembership = false,
    failHistory = false;
  const admitted = [],
    callbackPosts = [];
  const mattermost = createServer((req, res) => {
    const u = new URL(req.url, "http://localhost");
    if (req.headers.authorization?.toLowerCase() !== "bearer " + pat || req.method !== "GET")
      return res.writeHead(403).end();
    res.setHeader("content-type", "application/json");
    if (u.pathname === "/mm/api/v4/users/me") return res.end(JSON.stringify(me));
    if (u.pathname === "/mm/api/v4/users/me/channels")
      return failMembership
        ? res.writeHead(503).end('{"message":"offline"}')
        : res.end(JSON.stringify(channels));
    const match = u.pathname.match(/^\/mm\/api\/v4\/channels\/([a-z0-9]+)\/posts$/);
    if (match) {
      if (failHistory) return res.writeHead(503).end('{"message":"fixture recovery unavailable"}');
      const ps = u.searchParams.has("before") ? [] : (history.get(match[1]) ?? []);
      return res.end(
        JSON.stringify({
          order: ps.map((p) => p.id),
          posts: Object.fromEntries(ps.map((p) => [p.id, p])),
        }),
      );
    }
    res.writeHead(404).end("{}");
  });
  const sessionId = "ses_subscribed",
    password = "private-opencode-fixture";
  const trap = createServer(async (req, res) => {
    if (req.method === "POST") callbackPosts.push(req.url);
    if (
      req.headers.authorization !==
      "Basic " + Buffer.from("opencode:" + password).toString("base64")
    )
      return res.writeHead(401).end();
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/session/" + sessionId && req.method === "GET")
      return res.end(JSON.stringify({ data: { id: sessionId } }));
    if (req.url !== "/api/session/" + sessionId + "/synthetic" || req.method !== "POST")
      return res.writeHead(404).end("{}");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    admitted.push(body);
    res.end(JSON.stringify({ data: { type: "synthetic", sessionID: sessionId, id: body.id } }));
  });
  const ws = new WebSocketServer({ server: mattermost, path: "/mm/api/v4/websocket" });
  let socket, seq;
  ws.on("connection", (s, req) => {
    if (req.headers.authorization !== "Bearer " + pat) return s.close(1008);
    socket = s;
    seq = 0;
    s.send(JSON.stringify({ event: "hello", seq: seq++, data: {} }));
  });
  const publish = (p, type) =>
    socket.send(
      JSON.stringify({
        event: "posted",
        seq: seq++,
        broadcast: { channel_id: p.channel_id },
        data: { channel_type: type, post: JSON.stringify(p) },
      }),
    );
  let service;
  try {
    const mmPort = await listen(mattermost),
      trapPort = await listen(trap);
    const passwordFile = join(dir, "callback-password");
    await writeFile(passwordFile, password, { mode: 0o600 });
    const env = {
      HOME: dir,
      XDG_CONFIG_HOME: dir,
      MM_URL: "http://127.0.0.1:" + mmPort + "/mm",
      MM_TOKEN: pat,
      MM_MAX_RETRIES: "0",
      MM_READ_ONLY: "false",
      MM_EVENTS_ENABLED: "true",
      MM_EVENTS_STATE_DIR: join(dir, "cache"),
      // Obsolete settings must never turn a cached post into an OpenCode prompt.
      MM_OPENCODE_URL: "http://127.0.0.1:" + trapPort,
      MM_OPENCODE_SESSION_ID: "ses_old",
      MM_OPENCODE_PASSWORD_FILE: passwordFile,
    };
    service = await startService(env);
    const catalog = await service.client.listTools();
    expect(catalog.tools).toHaveLength(41);
    expect(
      catalog.tools.find((t) => t.name === "list_cached_messages").annotations.readOnlyHint,
    ).toBe(true);
    await vi.waitFor(async () =>
      expect((await list(service.client)).messages.map((p) => p.postId)).toEqual([retained.id]),
    );
    publish(incoming, "P");
    publish(sent, "D");
    await vi.waitFor(async () =>
      expect((await list(service.client)).messages.map((p) => p.postId)).toEqual([
        sent.id,
        incoming.id,
        retained.id,
      ]),
    );
    expect(
      (
        await list(service.client, {
          direction: "incoming",
          channel_type: "P",
          sender_id: peer,
          since: at,
        })
      ).messages,
    ).toMatchObject([{ message: incoming.message }]);
    expect(
      (await list(service.client, { direction: "outgoing", channel_id: dm })).messages,
    ).toMatchObject([{ postId: sent.id, message: sent.message }]);

    expect(callbackPosts).toEqual([]);
    const subscription = await call(
      service.client,
      "subscribe_messages",
      {
        ttl_seconds: 120,
        direction: "incoming",
        channel_type: "D",
        channel_id: dm,
        sender_id: peer,
      },
      { "ai.opencode/sessionID": sessionId },
    );
    expect(subscription.callbackUrl).toBe(
      "http://127.0.0.1:" + trapPort + "/api/session/" + sessionId + "/synthetic",
    );
    // Another caller must not inherit the previous request's session hint.
    await expect(call(service.client, "subscribe_messages", { ttl_seconds: 120 })).rejects.toThrow(
      /exactly one/,
    );
    await expect(
      call(
        service.client,
        "subscribe_messages",
        { ttl_seconds: 120 },
        { "ai.opencode/sessionID": "../spoof" },
      ),
    ).rejects.toThrow(/exactly one/);
    expect(subscription.subscriptionId).toBeTruthy();
    const published = Date.now();
    publish(post("i", room, peer, published, "wrong channel"), "P");
    publish(post("j", dm, id("o"), published, "wrong sender"), "D");
    publish(post("k", dm, me.id, published, "own send"), "D");
    const matching = post("l", dm, peer, published, "matching private message");
    publish(matching, "D");
    publish(matching, "D"); // duplicate transport frame, same post
    await vi.waitFor(() => expect(admitted).toHaveLength(1), { timeout: 5000 });
    expect(admitted[0]).toMatchObject({
      id: expect.stringMatching(/^msg_/),
      resume: true,
      delivery: "queue",
    });
    expect(admitted[0].metadata.mattermost).toMatchObject({
      postId: matching.id,
      channelId: dm,
      senderId: peer,
      direction: "incoming",
    });
    expect(JSON.stringify(admitted[0])).not.toContain(matching.message);
    await service.stop();
    service = undefined;
    // Block REST history during the second launch; any returned body must have survived on disk.
    failHistory = true;
    service = await startService(env);
    expect((await list(service.client, { direction: "outgoing" })).messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ postId: sent.id, message: sent.message })]),
    );
    failMembership = true;
    await expect(list(service.client)).rejects.toThrow();
    failMembership = false;
    channels = channels.filter((c) => c.id !== room);
    expect((await list(service.client)).messages.map((p) => p.channelId)).not.toContain(room);
    await expect(list(service.client, { channel_id: room })).rejects.toThrow(
      /accessible joined channel/,
    );
    channels.push({ id: room, type: "P", team_id: id("t"), last_post_at: at });
    expect((await list(service.client, { channel_id: room })).messages).toEqual([]);
    expect(callbackPosts).toEqual(["/api/session/" + sessionId + "/synthetic"]);
  } finally {
    await service?.stop();
    for (const s of ws.clients) s.terminate();
    ws.close();
    await Promise.all([closeServer(mattermost), closeServer(trap)]);
    await rm(dir, { recursive: true, force: true });
  }
}, 20000);
