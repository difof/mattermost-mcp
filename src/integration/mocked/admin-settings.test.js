import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, it, vi } from "vitest";

const cli = fileURLToPath(new URL("../../index.js", import.meta.url));
const patA = "fixture-first-mattermost-pat",
  patB = "fixture-rotated-mattermost-pat",
  wrongAccount = "fixture-other-user-pat",
  invalid = "fixture-rejected-pat";
const httpA = "fixture-http-a-" + "a".repeat(32),
  httpB = "fixture-http-b-" + "b".repeat(32);
const adminA = "fixture-admin-a-" + "c".repeat(32),
  adminB = "fixture-admin-b-" + "d".repeat(32);
const secrets = [patA, patB, wrongAccount, invalid, httpA, httpB, adminA, adminB];

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}
async function close(server) {
  if (!server.listening) return;
  const stopped = once(server, "close");
  server.close();
  server.closeAllConnections();
  await stopped;
}

it("applies and persists settings, rejects bad rotations and swaps all validated credentials without restarting the CLI", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mm-admin-cli-")),
    usedTokens = [],
    unexpected = [];
  const me = { id: "a".repeat(26), username: "fixture" };
  const mm = createServer((req, res) => {
    const [scheme, token] = (req.headers.authorization ?? "").split(" ");
    res.setHeader("content-type", "application/json");
    if (
      req.url !== "/api/v4/users/me" ||
      req.method !== "GET" ||
      scheme?.toLowerCase() !== "bearer"
    ) {
      unexpected.push([req.method, req.url]);
      return res.writeHead(403).end("{}");
    }
    usedTokens.push(token);
    if (token === patA || token === patB) return res.end(JSON.stringify(me));
    if (token === wrongAccount)
      return res.end(JSON.stringify({ id: "b".repeat(26), username: "other" }));
    res
      .writeHead(401)
      .end(JSON.stringify({ status_code: 401, message: "mock rejection: " + invalid }));
  });
  const patFile = join(dir, "pat"),
    httpFile = join(dir, "http"),
    adminFile = join(dir, "admin"),
    settingsFile = join(dir, "settings.json");
  const privateText = (file, value) => writeFile(file, value + "\n", { mode: 0o600 });
  const clients = [];
  let service,
    diagnostics = "";
  async function stop() {
    await Promise.allSettled(clients.splice(0).map((c) => c.close()));
    if (service && service.exitCode === null && service.signalCode === null) {
      const exited = once(service, "exit");
      service.kill("SIGTERM");
      await exited;
    }
    service = undefined;
  }
  async function connect(url, token) {
    const c = new Client({ name: "admin-reload-check", version: "1" });
    clients.push(c);
    await c.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { authorization: "Bearer " + token } },
      }),
    );
    return c;
  }
  function scrub(s) {
    for (const secret of secrets) expect(s).not.toContain(secret);
  }
  async function result(c, name, args = {}) {
    const r = await c.callTool({ name, arguments: args });
    scrub(JSON.stringify(r));
    return r;
  }
  async function call(c, name, args) {
    const r = await result(c, name, args);
    expect(r.isError).not.toBe(true);
    return JSON.parse(r.content[0].text);
  }
  try {
    const mmPort = await listen(mm),
      reservation = createServer(),
      port = await listen(reservation);
    await close(reservation);
    const url = "http://127.0.0.1:" + port + "/mcp",
      adminUrl = url + "/admin";
    await Promise.all([
      privateText(patFile, patA),
      privateText(httpFile, httpA),
      privateText(adminFile, adminA),
    ]);
    async function start() {
      let output = "";
      service = spawn(process.execPath, [cli, "serve"], {
        env: {
          HOME: dir,
          XDG_CONFIG_HOME: dir,
          XDG_STATE_HOME: dir,
          MM_AUTH_MODE: "pat",
          MM_TOKEN_FILE: patFile,
          MM_HTTP_TOKEN_FILE: httpFile,
          MM_ADMIN_TOKEN_FILE: adminFile,
          MM_SETTINGS_FILE: settingsFile,
          MM_HTTP_PORT: String(port),
          MM_URL: "http://127.0.0.1:" + mmPort,
          MM_MAX_RETRIES: "0",
          MM_EVENTS_ENABLED: "false",
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      service.stderr.on("data", (chunk) => {
        output += chunk;
        diagnostics += chunk;
      });
      await vi.waitFor(
        () => {
          if (service.exitCode !== null) throw new Error("Service exited during initialization");
          expect(output).toContain("serving MCP at");
        },
        { timeout: 5000 },
      );
    }
    const unauthorized = async (path, token) => {
      const res = await fetch(path, { headers: { authorization: "Bearer " + token } });
      await res.body?.cancel();
      expect(res.status).toBe(401);
    };
    await start();
    const normal = await connect(url, httpA),
      admin = await connect(adminUrl, adminA),
      pid = service.pid;
    const before = await call(admin, "list_settings");
    expect(before.settings.retention_hours.value).toBe(48);
    expect(before.secrets).toBeDefined();
    const changed = await call(admin, "set_settings", {
      expected_revision: before.revision,
      patch: { retention_hours: 72, read_only: true },
    });
    expect(changed.revision).not.toEqual(before.revision);
    const state = await call(admin, "list_settings");
    expect(state.settings.retention_hours.value).toBe(72);
    expect(state.settings.read_only.value).toBe(true);
    expect(
      (await result(normal, "post_message", { channel_id: "blocked", message: "must never send" }))
        .isError,
    ).toBe(true);
    expect(
      (
        await result(admin, "set_settings", {
          patch: { read_only: false },
          expected_revision: before.revision,
        })
      ).isError,
    ).toBe(true);

    // All three secret files are staged. A failed PAT verification cannot partially
    // activate either new bearer, change accounts or echo a hostile upstream error.
    await Promise.all([privateText(httpFile, httpB), privateText(adminFile, adminB)]);
    for (const bad of [invalid, wrongAccount]) {
      await privateText(patFile, bad);
      expect(
        (await result(admin, "reload_settings", { expected_revision: state.revision })).isError,
      ).toBe(true);
      expect(usedTokens).toContain(bad);
      expect(await call(normal, "get_me")).toMatchObject(me);
      expect(usedTokens.at(-1)).toBe(patA);
      expect((await call(admin, "list_settings")).revision).toBe(state.revision);
      await unauthorized(url, httpB);
      await unauthorized(adminUrl, adminB);
    }

    await privateText(patFile, patB);
    await call(admin, "reload_settings", { expected_revision: state.revision });
    await unauthorized(url, httpA);
    await unauthorized(adminUrl, adminA);
    const replaced = await connect(url, httpB),
      newAdmin = await connect(adminUrl, adminB);
    expect(await call(replaced, "get_me")).toMatchObject(me);
    expect(usedTokens.at(-1)).toBe(patB);
    expect((await call(newAdmin, "list_settings")).settings.retention_hours.value).toBe(72);
    expect(service.pid).toBe(pid);
    expect(service.exitCode).toBeNull();
    const nextListener = createServer();
    const nextPort = await listen(nextListener);
    await close(nextListener);
    await call(newAdmin, "set_settings", { patch: { http_port: nextPort } });
    expect(await call(replaced, "get_me")).toMatchObject(me); // old address remains live
    scrub(await readFile(settingsFile, "utf8"));
    await stop();
    await start(); // unchanged MM_HTTP_PORT; persisted port now takes effect
    const restarted = await connect("http://127.0.0.1:" + nextPort + "/mcp/admin", adminB);
    expect((await call(restarted, "list_settings")).settings).toMatchObject({
      retention_hours: { value: 72 },
      read_only: { value: true },
    });
    expect(unexpected).toEqual([]);
    scrub(diagnostics);
  } finally {
    await stop();
    await close(mm);
    await rm(dir, { recursive: true, force: true });
  }
}, 20000);
