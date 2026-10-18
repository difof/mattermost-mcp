// Offline integration harness: MCP Client -> registry -> real Client4 -> loopback HTTP.
// Only the Mattermost server is simulated. Every request must match a queued contract;
// unexpected requests, missing requests, wrong credentials, and outside origins fail.
// These are transport contracts, not an emulation of server permission checks.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { afterEach, beforeEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createSession } from "../../mattermost/client.js";
import { allTools } from "../../tools/index.js";
import { registerTools } from "../../tools/registry.js";
export const ME = { id: "personal-user", username: "casey" };
export const PEER = { id: "colleague-user", username: "robin" };
export const OK = { status: "OK" };
const TOKEN = "test-only-personal-pat";
const DEPLOYMENT_PATH = "/mattermost";
async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
export class MattermostHttpFixture {
  url = "";
  expected = [];
  failures = [];
  http = createServer((request, response) => {
    void this.respond(request).then(
      ({ expectation, bytes }) => {
        response.writeHead(expectation.status ?? 200, {
          "Content-Type": expectation.bytes ? "application/octet-stream" : "application/json",
          ...(expectation.chunked ? {} : { "Content-Length": String(bytes.length) }),
          ...expectation.headers,
        });
        if (expectation.chunked) response.write(bytes);
        response.end(expectation.chunked ? undefined : bytes);
      },
      (error) => {
        this.failures.push(error instanceof Error ? error.message : String(error));
        // A non-retryable response makes a contract failure immediate and readable.
        response.writeHead(418, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({ status_code: 418, message: "Unexpected mock Mattermost request" }),
        );
      },
    );
  });
  constructor(options) {
    this.options = options;
    this.guardrails = {
      readOnly: false,
      allowDestructive: false,
      teamAllowlist: [],
      channelAllowlist: [],
      maxMessageLen: 16383,
      ...options.guardrails,
    };
  }
  expect(method, path, exchange = {}) {
    this.expected.push({ method, path, ...exchange });
  }
  async respond(request) {
    const received = `${request.method} ${request.url}`;
    const expectation = this.expected.shift();
    assert.ok(expectation, `Unplanned HTTP request: ${received}`);
    assert.equal(request.method, expectation.method, received);
    const url = new URL(request.url, "http://fixture.invalid");
    assert.equal(url.pathname, `${DEPLOYMENT_PATH}/api/v4${expectation.path}`, received);
    assert.deepEqual(
      [...url.searchParams.entries()].sort(),
      Object.entries(expectation.query ?? {})
        .flatMap(([key, value]) =>
          (Array.isArray(value) ? value : [value]).map((item) => [key, String(item)]),
        )
        .sort(),
      `Wrong query: ${received}`,
    );
    const [scheme, token] = (request.headers.authorization ?? "").split(" ");
    assert.equal(scheme?.toLowerCase(), "bearer", `Missing PAT auth: ${received}`);
    assert.equal(token, TOKEN, `Wrong PAT identity: ${received}`);
    assert.equal(request.headers.cookie, undefined, "PAT requests must not depend on cookies");
    for (const [name, value] of Object.entries(expectation.requestHeaders ?? {})) {
      assert.equal(request.headers[name.toLowerCase()], value, `Wrong ${name} header: ${received}`);
    }
    const body = await readBody(request);
    if (expectation.inspectBody) {
      await expectation.inspectBody(body, request.headers);
    } else if (Object.hasOwn(expectation, "body")) {
      assert.deepEqual(JSON.parse(body.toString("utf8")), expectation.body, received);
    } else {
      assert.equal(body.length, 0, `Unexpected request body: ${received}`);
    }
    const noBody =
      expectation.empty ||
      expectation.method === "HEAD" ||
      [204, 304].includes(expectation.status ?? 200);
    const bytes = noBody
      ? Buffer.alloc(0)
      : (expectation.bytes ??
        Buffer.from(JSON.stringify(Object.hasOwn(expectation, "reply") ? expectation.reply : OK)));
    return { expectation, bytes };
  }
  async start() {
    await new Promise((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(0, "127.0.0.1", resolve);
    });
    const origin = `http://127.0.0.1:${this.http.address().port}`;
    this.url = `${origin}${DEPLOYMENT_PATH}`;
    const nativeFetch = globalThis.fetch;
    // Enforce offline operation but let the real fetch perform every local exchange.
    const fetchGuard = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      assert.equal(url.origin, origin, "Integration tests cannot contact outside services");
      if (this.expected[0]?.fetchRedirect != null) {
        assert.equal(init?.redirect, this.expected[0].fetchRedirect, "Unsafe redirect mode");
      }
      return nativeFetch(input, init);
    });
    this.restoreFetch = () => fetchGuard.mockRestore();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    this.restoreLog = () => log.mockRestore();
    this.expect("GET", "/users/me", { reply: this.options.user ?? ME });
    const session = await createSession({
      url: this.url,
      auth: { mode: "pat", token: TOKEN },
      guardrails: this.guardrails,
      resilience: { timeoutMs: 2000, maxRetries: 1, baseDelayMs: 1, ...this.options.resilience },
    });
    this.server = new Server(
      { name: "mattermost-http-test", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    registerTools(this.server, allTools, { session });
    this.mcp = new Client({ name: "personal-agent-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([this.server.connect(serverTransport), this.mcp.connect(clientTransport)]);
  }
  async listTools() {
    assert.ok(this.mcp);
    return this.mcp.listTools();
  }
  async result(name, args) {
    assert.ok(this.mcp);
    const result = CallToolResultSchema.parse(await this.mcp.callTool({ name, arguments: args }));
    assert.deepEqual(this.failures, [], "Mattermost HTTP contract failed");
    assert.equal(result.content.length, 1);
    const content = result.content[0];
    assert.equal(content.type, "text");
    return { text: content.text, isError: result.isError };
  }
  async call(name, args = {}) {
    const result = await this.result(name, args);
    assert.ok(!result.isError, `${name} failed: ${result.text}`);
    return JSON.parse(result.text);
  }
  async error(name, args = {}) {
    const result = await this.result(name, args);
    assert.equal(result.isError, true, `${name} unexpectedly succeeded: ${result.text}`);
    return result.text;
  }
  async close() {
    try {
      await this.mcp?.close();
      await this.server?.close();
    } finally {
      try {
        if (this.http.listening) {
          await new Promise((resolve, reject) => {
            this.http.close((error) => (error ? reject(error) : resolve()));
            this.http.closeAllConnections();
          });
        }
      } finally {
        this.restoreFetch?.();
        this.restoreLog?.();
      }
    }
    assert.deepEqual(this.failures, [], "Mattermost HTTP contract failed");
    assert.deepEqual(
      this.expected.map(({ method, path }) => `${method} ${path}`),
      [],
      "Expected HTTP requests were not made",
    );
  }
}
/** A fresh authenticated server/session per test; no environment credentials are read. */
export function useMattermost(options = {}) {
  let fixture;
  beforeEach(async () => {
    fixture = new MattermostHttpFixture(options);
    await fixture.start();
  });
  afterEach(async () => {
    await fixture?.close();
  });
  return () => fixture;
}
