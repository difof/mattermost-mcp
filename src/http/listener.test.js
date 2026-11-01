import { request } from "node:http";
import { afterEach, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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

async function connect(name) {
  const client = new Client({ name, version: "test" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(http.url), { requestInit: { headers } }),
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
function exchange({ auth = true, method = "POST", extra = {}, chunks = [] } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      http.url,
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
