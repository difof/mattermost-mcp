import { request } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { requestSignal } from "../mattermost/request-signal.js";
import { loadConfig } from "../config.js";
import { listenHttp } from "./listener.js";

const token = "http-test-bearer-12345678901234567890";
const headers = { authorization: "Bearer " + token };
const session = {
  config: loadConfig({ MM_URL: "http://127.0.0.1", MM_TOKEN: "mock-pat", MM_READ_ONLY: "true" }),
  call: (fn) => fn({ getUser: async (id) => ({ id }) }),
};
let http;
const clients = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await http?.close();
  http = undefined;
});

async function connect(name, url = http.url, authHeaders = headers) {
  const client = new Client({ name, version: "test" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: authHeaders } }),
  );
  return client;
}

it("isolates simultaneous MCP clients sharing one account and enforces its tools policy", async () => {
  http = await listenHttp(session, { port: 0, token, maxBodyBytes: 4096 });
  const [a, b] = await Promise.all([connect("opencode"), connect("tunnel")]);
  const results = await Promise.all(
    [a, b].map((c, i) => c.callTool({ name: "get_user", arguments: { user_id: "user" + i } })),
  );
  expect(results.map((x) => JSON.parse(x.content[0].text).id)).toEqual(["user0", "user1"]);
  expect((await b.listTools()).tools.some((t) => t.name === "upload_file")).toBe(true);
  const denied = await a.callTool({
    name: "post_message",
    arguments: { channel_id: "channel", message: "never sent" },
  });
  expect(denied.isError).toBe(true);
  expect(denied.content[0].text).toMatch(/read.only/i);
});

it("drains an admitted tool call when the listener shuts down", async () => {
  let entered, finish;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  http = await listenHttp(
    {
      ...session,
      call: async () => {
        entered();
        return pending;
      },
    },
    { port: 0, token, maxBodyBytes: 4096 },
  );
  const client = await connect("drain");
  const call = client.callTool({ name: "get_me", arguments: {} });
  await started;
  const closing = http.close();
  http = undefined;
  finish({ id: "complete" });
  expect(JSON.parse((await call).content[0].text)).toEqual({ id: "complete" });
  await closing;
});

// Use raw HTTP so Host and chunked framing reach Node exactly as a client supplied them.
function exchange({ url = http.url, auth = true, method = "POST", extra = {}, chunks = [] } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method,
        headers: {
          ...(auth ? headers : {}),
          "content-type": "application/json",
          ...extra,
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

it("refuses missing bearer, foreign hosts and origins, and declared or streamed oversized bodies", async () => {
  http = await listenHttp(session, { port: 0, token, maxBodyBytes: 32 });
  expect(await exchange({ auth: false })).toBe(401);
  expect(await exchange({ extra: { host: "rebinding.invalid" } })).toBe(403);
  expect(await exchange({ extra: { origin: "https://other.invalid" } })).toBe(403);
  expect(await exchange({ method: "GET" })).toBe(405);
  expect(await exchange({ chunks: ["malformed"] })).toBe(400);
  expect(await exchange({ extra: { "content-length": "33" }, chunks: ["x".repeat(33)] })).toBe(413);
  expect(await exchange({ chunks: ["x".repeat(20), "y".repeat(20)] })).toBe(413);
});

it("separates admin calls from all ordinary credentials, tools and raw inputs", async () => {
  const adminToken = "management-test-bearer-12345678901234567890";
  const secret = "accidental-secret-string-must-never-echo";
  const revision = "f".repeat(64);
  let value = 48;
  const manager = {
    list: () => ({ retention_hours: value, revision, secrets: { mattermost_pat: "configured" } }),
    set(patch, expected) {
      if (expected !== revision)
        throw Object.assign(new Error(secret), { code: "REVISION_CONFLICT" });
      value = patch.retention_hours;
      return { applied: patch };
    },
    reload: () => {
      throw new Error(secret);
    },
  };
  http = await listenHttp(session, { port: 0, token, adminToken, maxBodyBytes: 4096 }, manager);
  const adminUrl = http.url + "/admin",
    adminHeaders = { authorization: "Bearer " + adminToken };
  expect(await exchange({ url: adminUrl })).toBe(401);
  expect(await exchange({ extra: adminHeaders })).toBe(401);
  expect(await exchange({ url: adminUrl, auth: false })).toBe(401);
  expect(
    await exchange({
      url: adminUrl,
      extra: { ...adminHeaders, origin: "http://attacker.invalid" },
    }),
  ).toBe(403);
  const [ordinary, admin] = await Promise.all([
    connect("ordinary"),
    connect("admin", adminUrl, adminHeaders),
  ]);
  const names = (await admin.listTools()).tools.map((t) => t.name);
  expect(names).toEqual(["list_settings", "set_settings", "reload_settings"]);
  expect((await ordinary.listTools()).tools.every((t) => !names.includes(t.name))).toBe(true);
  await expect(
    ordinary.callTool({ name: "set_settings", arguments: { patch: { retention_hours: 12 } } }),
  ).rejects.toThrow(/unknown tool/i);
  await expect(admin.callTool({ name: "post_message", arguments: {} })).rejects.toThrow(
    /unknown management tool/i,
  );
  const call = (name, args = {}) => admin.callTool({ name, arguments: args });
  const set = await call("set_settings", {
    patch: { retention_hours: 72 },
    expected_revision: revision,
  });
  expect(JSON.parse(set.content[0].text)).toEqual({ applied: { retention_hours: 72 } });
  expect(JSON.parse((await call("list_settings")).content[0].text)).toMatchObject({
    retention_hours: 72,
  });
  for (const [name, args] of [
    ["set_settings", { patch: { [secret]: secret } }],
    ["set_settings", { patch: { retention_hours: secret } }],
    ["set_settings", { patch: { retention_hours: 120 }, expected_revision: "0".repeat(64) }],
    ["reload_settings", {}],
    ["list_settings", { [secret]: secret }],
  ]) {
    const denied = await call(name, args);
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).not.toContain(secret);
  }
  expect(value).toBe(72);
});

it("reads current bearers and request policy, and keeps recovery outside the ordinary lease", async () => {
  const settings = {
    port: 0,
    token,
    adminToken: "first-admin-token-123456789012345678901",
    maxBodyBytes: 4096,
  };
  let paused = true,
    active = 0;
  const current = () => session;
  current.acquire = () => {
    if (paused) return null;
    active++;
    return {
      session,
      release: () => {
        active--;
      },
    };
  };
  const manager = {
    list: () => ({ ready: true }),
    reload: () => {
      settings.token = "second-ordinary-token-123456789012345678901";
      settings.adminToken = "second-admin-token-123456789012345678901";
      settings.maxBodyBytes = 1;
      return { rotated: true };
    },
    set: () => {
      settings.maxBodyBytes = 4096;
      return { ready: true };
    },
  };
  http = await listenHttp(current, settings, manager);
  const url = http.url + "/admin",
    old = { authorization: "Bearer " + settings.adminToken };
  expect(await exchange({ chunks: ["{}"] })).toBe(503);
  const admin = await connect("recovery", url, old);
  expect(
    JSON.parse((await admin.callTool({ name: "reload_settings", arguments: {} })).content[0].text),
  ).toEqual({ rotated: true });
  expect(await exchange({ url, extra: old })).toBe(401);
  expect(await exchange()).toBe(401);
  const regular = { authorization: "Bearer " + settings.token };
  expect(await exchange({ extra: regular, chunks: ["{}"] })).toBe(413);
  const credentials = { authorization: "Bearer " + settings.adminToken };
  expect(await exchange({ url, extra: { ...credentials, "content-length": "16385" } })).toBe(413);
  const recovered = await connect("recovery-rotated", url, credentials);
  await recovered.callTool({
    name: "set_settings",
    arguments: { patch: { http_max_body_bytes: 4096 } },
  });
  paused = false;
  const rotated = await connect("regular-rotated", http.url, regular);
  expect((await rotated.listTools()).tools.some((t) => t.name === "get_me")).toBe(true);
  expect(active).toBe(0);
  settings.adminToken = undefined;
  expect(await exchange({ url, extra: credentials })).toBe(404);
});

it("revokes slow uploads admitted under old credentials or an older body limit", async () => {
  const settings = {
    port: 0,
    token,
    adminToken: "old-admin-123456789012345678901234567890",
    maxBodyBytes: 4096,
  };
  http = await listenHttp(session, settings, { list: () => ({}) });
  function start(url, bearer) {
    let begin, req;
    const accepted = new Promise((resolve) => {
      begin = resolve;
    });
    const status = new Promise((resolve, reject) => {
      req = request(
        url,
        {
          method: "POST",
          headers: {
            expect: "100-continue",
            authorization: "Bearer " + bearer,
            "content-type": "application/json",
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
      req.on("continue", () => {
        req.write("{");
        begin();
      });
      req.flushHeaders();
    });
    return {
      accepted,
      finish: () => {
        req.end("}");
        return status;
      },
    };
  }
  const regular = start(http.url, settings.token),
    admin = start(http.url + "/admin", settings.adminToken);
  await Promise.all([regular.accepted, admin.accepted]);
  settings.token = "new-normal-123456789012345678901234567890";
  settings.adminToken = "new-admin-123456789012345678901234567890";
  expect(await Promise.all([regular.finish(), admin.finish()])).toEqual([401, 401]);
  const limited = start(http.url, settings.token);
  await limited.accepted;
  settings.maxBodyBytes = 1;
  expect(await limited.finish()).toBe(413);
});

it("rejects RPC batches and holds admission until abandoned tool work settles", async () => {
  let entered,
    cancelled,
    finish,
    readers = 0;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const aborted = new Promise((resolve) => {
    cancelled = resolve;
  });
  const hold = new Promise((resolve) => {
    finish = resolve;
  });
  const active = {
    ...session,
    call: async () => {
      const signal = requestSignal();
      signal.addEventListener("abort", cancelled, { once: true });
      entered();
      // Model an integration that acknowledges cancellation before finishing its cleanup.
      await hold;
      return { id: "fixture" };
    },
  };
  const get = () => active;
  get.acquire = () => {
    readers++;
    return { session: active, release: () => readers-- };
  };
  const adminToken = "other-local-admin-12345678901234567890";
  http = await listenHttp(
    get,
    { port: 0, token, maxBodyBytes: 4096, maxConcurrent: 1, adminToken },
    { list: () => ({}) },
  );
  const ping = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
  const extra = { accept: "application/json, text/event-stream" };
  expect(await exchange({ extra, chunks: ["[" + ping + "]"] })).toBe(400);
  const peer = request(http.url, {
    method: "POST",
    headers: { ...headers, ...extra, "content-type": "application/json" },
  });
  peer.on("error", () => {});
  peer.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_me", arguments: {} },
    }),
  );
  try {
    await started;
    peer.destroy();
    await aborted;
    expect(readers).toBe(1);
    expect(await exchange({ extra, chunks: [ping] })).toBe(429);
    expect(
      await exchange({
        url: http.url + "/admin",
        extra: { ...extra, authorization: "Bearer " + adminToken },
        chunks: [ping],
      }),
    ).toBe(200);
  } finally {
    finish();
    peer.destroy();
  }
  await vi.waitFor(() => expect(readers).toBe(0));
  expect(await exchange({ extra, chunks: [ping] })).toBe(200);
});

it("caps serialized tool output even when a handler combines many successful reads", async () => {
  http = await listenHttp(
    {
      ...session,
      config: { ...session.config, maxResponseBytes: 2048 },
      call: async () => ({ field: "x".repeat(300 * 1024) }),
    },
    { port: 0, token, maxBodyBytes: 4096 },
  );
  const client = await connect("result-limit");
  const r = await client.callTool({ name: "get_me", arguments: {} });
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toMatch(/result is too large/);
  expect((await client.listTools()).tools.length).toBeGreaterThan(0);
});
