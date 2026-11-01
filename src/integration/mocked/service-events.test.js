import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebSocketServer } from "ws";
import { expect, it } from "vitest";

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
const cli = fileURLToPath(new URL("../../index.js", import.meta.url));

it("serves MCP and wakes the configured inbox with IDs from an authenticated Mattermost DM", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mattermost-service-"));
  const pat = "fixture-mattermost-pat";
  const token = "fixture-loopback-mcp-token-1234567890123456";
  const password = "fixture-opencode-password";
  const sessionID = "ses_fixture";
  const me = { id: "a".repeat(26), username: "operator" };
  const post = {
    id: "b".repeat(26),
    channel_id: "c".repeat(26),
    user_id: "d".repeat(26),
    message: "private fixture text must stay in Mattermost",
    create_at: Date.now(),
  };
  const requests = [];
  const mattermost = createServer((req, res) => {
    requests.push(req.method + " " + req.url);
    const [scheme, presented] = (req.headers.authorization ?? "").split(" ");
    if (scheme.toLowerCase() !== "bearer" || presented !== pat || req.method !== "GET") {
      res.writeHead(403).end();
      return;
    }
    const path = new URL(req.url, "http://localhost").pathname;
    res.setHeader("content-type", "application/json");
    if (path === "/mm/api/v4/users/me") res.end(JSON.stringify(me));
    else if (path === "/mm/api/v4/users/me/channels") res.end("[]");
    else res.writeHead(404).end();
  });
  const ws = new WebSocketServer({ server: mattermost, path: "/mm/api/v4/websocket" });
  ws.on("connection", (socket, req) => {
    if (req.headers.authorization !== "Bearer " + pat) return socket.close(1008);
    socket.send(JSON.stringify({ event: "hello", seq: 0, data: {} }));
    socket.send(
      JSON.stringify({
        event: "posted",
        seq: 1,
        data: { channel_type: "D", post: JSON.stringify(post) },
      }),
    );
  });
  const receipt = new EventEmitter();
  const opencode = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ data: { type: "synthetic", sessionID, id: body.id } }));
    receipt.emit("admitted", {
      method: req.method,
      path: req.url,
      auth: req.headers.authorization,
      body,
    });
  });
  const client = new Client({ name: "service-test", version: "0" });
  let child;
  try {
    const mmPort = await listen(mattermost);
    const ocPort = await listen(opencode);
    // The CLI requires a fixed nonzero port; reserve an ephemeral one for this run.
    const reservation = createServer();
    const port = await listen(reservation);
    await closeServer(reservation);
    await writeFile(join(dir, "mcp-token"), token, { mode: 0o600 });
    await writeFile(join(dir, "oc-password"), password, { mode: 0o600 });
    child = spawn(process.execPath, [cli, "serve"], {
      env: {
        HOME: dir,
        XDG_CONFIG_HOME: dir,
        MM_URL: `http://127.0.0.1:${mmPort}/mm`,
        MM_TOKEN: pat,
        MM_READ_ONLY: "true",
        MM_MAX_RETRIES: "0",
        MM_HTTP_PORT: String(port),
        MM_HTTP_TOKEN_FILE: join(dir, "mcp-token"),
        MM_EVENTS_ENABLED: "true",
        MM_EVENTS_STATE_DIR: join(dir, "state"),
        MM_OPENCODE_URL: `http://127.0.0.1:${ocPort}`,
        MM_OPENCODE_SESSION_ID: sessionID,
        MM_OPENCODE_PASSWORD_FILE: join(dir, "oc-password"),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let diagnostics = "";
    child.stderr.on("data", (chunk) => {
      diagnostics += chunk.toString();
    });
    const [admitted] = await once(receipt, "admitted", { signal: AbortSignal.timeout(8000) }).catch(
      () => {
        throw new Error("No inbox delivery. " + requests.join(", ") + "\n" + diagnostics);
      },
    );
    expect(admitted).toMatchObject({
      method: "POST",
      path: "/api/session/" + sessionID + "/synthetic",
      auth: "Basic " + Buffer.from("opencode:" + password).toString("base64"),
      body: {
        id: expect.stringMatching(/^msg_[a-z0-9]+$/),
        delivery: "queue",
        resume: true,
        metadata: {
          source: "mattermost",
          mattermost: {
            kind: "dm",
            postId: post.id,
            rootId: post.id,
            channelId: post.channel_id,
            senderId: post.user_id,
          },
        },
      },
    });
    expect(JSON.stringify(admitted.body)).not.toContain(post.message);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { authorization: "Bearer " + token } },
      }),
    );
    expect((await client.listTools()).tools.some((t) => t.name === "get_post")).toBe(true);
    await client.close();
    const exited = once(child, "exit", { signal: AbortSignal.timeout(5000) });
    child.kill("SIGTERM");
    expect(await exited).toEqual([0, null]);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    for (const socket of ws.clients) socket.terminate();
    ws.close();
    await Promise.all([closeServer(mattermost), closeServer(opencode)]);
    await rm(dir, { recursive: true, force: true });
  }
}, 18000);
