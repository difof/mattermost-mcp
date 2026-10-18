import { describe, it, expect, vi, afterEach } from "vitest";
import type { Client4 } from "@mattermost/client";
import mattermost from "@mattermost/client";
import type { Config, GuardrailConfig } from "../config.js";
import type { MattermostSession } from "../mattermost/types.js";
import { dispatchToolCall } from "./registry.js";
import { fileTools } from "./files.js";
import { applyRequestResilience, applyRequestTimeout } from "../mattermost/resilience.js";

// --- fixtures ----------------------------------------------------------------

function fakeSession(
  guardrails: Partial<GuardrailConfig> = {},
  client: Partial<Client4> = {},
): MattermostSession {
  const config: Config = {
    url: "http://mm.test",
    auth: { mode: "pat", token: "t" },
    guardrails: {
      readOnly: false,
      allowDestructive: false,
      teamAllowlist: [],
      channelAllowlist: [],
      maxMessageLen: 16383,
      ...guardrails,
    },
  };
  return { client: client as Client4, config, userId: "me1", call: (fn) => fn(client as Client4) };
}

async function call(
  name: string,
  args: unknown,
  guardrails: Partial<GuardrailConfig> = {},
  client: Partial<Client4> = {},
): Promise<{ text: string; isError: boolean }> {
  const res = await dispatchToolCall(
    fileTools,
    { session: fakeSession(guardrails, client) },
    name,
    args,
  );
  return { text: (res.content[0] as { text: string }).text, isError: res.isError === true };
}

/** Real Client4 so file requests exercise its authentication/options handling. */
function rawFetchClient(): Client4 {
  const client = new mattermost.Client4();
  client.setUrl("http://mm.test");
  client.setToken("tok");
  client.setIncludeCookies(false);
  client.setUserAgent("mattermost-mcp/test");
  applyRequestTimeout(client, 30_000);
  return client;
}

afterEach(() => vi.unstubAllGlobals());

// --- tests -------------------------------------------------------------------

describe("upload_file", () => {
  it("happy path — returns mapped file info", async () => {
    const uploadFile = vi.fn(async () => ({
      file_infos: [{ id: "f42", name: "hi.txt", size: 2, mime_type: "text/plain" }],
      client_ids: [],
    }));
    const { text, isError } = await call(
      "upload_file",
      {
        channel_id: "c1",
        filename: "hi.txt",
        content_base64: Buffer.from("hi").toString("base64"),
      },
      {},
      { uploadFile } as unknown as Partial<Client4>,
    );
    expect(isError).toBe(false);
    expect(text).toContain("f42");
    expect(uploadFile).toHaveBeenCalledOnce();
  });

  it("blocked under MM_READ_ONLY", async () => {
    const { text, isError } = await call(
      "upload_file",
      { channel_id: "c1", filename: "hi.txt", content_base64: "aGk=" },
      { readOnly: true },
    );
    expect(isError).toBe(true);
    expect(text).toMatch(/read-only/);
  });

  it("blocked by channel allowlist", async () => {
    const { text, isError } = await call(
      "upload_file",
      { channel_id: "c9", filename: "hi.txt", content_base64: "aGk=" },
      { channelAllowlist: ["c1"] },
    );
    expect(isError).toBe(true);
    expect(text).toMatch(/MM_CHANNEL_ALLOWLIST/);
  });
});

describe("get_file_metadata", () => {
  it("returns the JSON metadata from the API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ id: "f1", name: "a.txt" })),
    );
    const { text, isError } = await call(
      "get_file_metadata",
      { file_id: "f1" },
      {},
      rawFetchClient(),
    );
    expect(isError).toBe(false);
    expect(text).toContain("f1");
  });

  it("uses Client4 authentication, default headers, and the configured timeout", async () => {
    const fetch = vi.fn(async () => Response.json({ id: "f1", name: "a.txt" }));
    vi.stubGlobal("fetch", fetch);
    const client = rawFetchClient();
    client.defaultHeaders["X-Custom-Header"] = "custom-value";
    const { isError } = await call("get_file_metadata", { file_id: "f1" }, {}, client);
    expect(isError).toBe(false);
    expect(fetch).toHaveBeenCalledWith(
      "http://mm.test/api/v4/files/f1/info",
      expect.objectContaining({
        method: "get",
        signal: expect.any(AbortSignal),
        headers: expect.objectContaining({
          Authorization: expect.stringMatching(/^Bearer tok$/i),
          "User-Agent": "mattermost-mcp/test",
          "X-Custom-Header": "custom-value",
        }),
      }),
    );
  });

  it("surfaces a non-ok response as Mattermost API error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Not found", { status: 404 })),
    );
    const { text, isError } = await call(
      "get_file_metadata",
      { file_id: "missing" },
      {},
      rawFetchClient(),
    );
    expect(isError).toBe(true);
    expect(text).toMatch(/Mattermost API error 404/);
  });

  it("preserves the HTTP status and Mattermost error details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            message: "Permission denied",
            id: "api.file.get_info.permissions.app_error",
            detailed_error: "Missing read_channel",
          },
          { status: 403 },
        ),
      ),
    );
    const { text, isError } = await call(
      "get_file_metadata",
      { file_id: "f1" },
      {},
      rawFetchClient(),
    );
    expect(isError).toBe(true);
    expect(text).toContain("Mattermost API error 403: Permission denied");
    expect(text).toContain("api.file.get_info.permissions.app_error");
    expect(text).toContain("Missing read_channel");
  });

  it("retries a transient metadata response through the session request policy", async () => {
    const fetch = vi
      .fn(async () => Response.json({ id: "f1", name: "a.txt" }))
      .mockResolvedValueOnce(new Response("Service unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const client = rawFetchClient();
    applyRequestResilience(client, { timeoutMs: 30_000, maxRetries: 1, baseDelayMs: 1 });
    const { text, isError } = await call("get_file_metadata", { file_id: "f1" }, {}, client);
    expect(isError).toBe(false);
    expect(text).toContain("f1");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("get_file", () => {
  it("returns base64 content of the downloaded file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("hello")),
    );
    const { text, isError } = await call("get_file", { file_id: "f1" }, {}, rawFetchClient());
    expect(isError).toBe(false);
    // "hello" in base64
    expect(text).toContain(Buffer.from("hello").toString("base64")); // "aGVsbG8="
  });

  it("rebuilds authentication after a recoverable 401 response", async () => {
    const fetch = vi
      .fn(async () => new Response("hello"))
      .mockResolvedValueOnce(Response.json({ message: "Session expired" }, { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    const client = rawFetchClient();
    const recover = vi.fn(async () => {
      client.setToken("refreshed");
      return true;
    });
    applyRequestResilience(client, { timeoutMs: 30_000, maxRetries: 0, baseDelayMs: 1 }, recover);
    const { text, isError } = await call("get_file", { file_id: "f1" }, {}, client);
    expect(isError).toBe(false);
    expect(JSON.parse(text).content_base64).toBe("aGVsbG8=");
    expect(recover).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "http://mm.test/api/v4/files/f1",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: expect.stringMatching(/^Bearer refreshed$/i),
        }),
      }),
    );
  });

  it("rejects when file exceeds max_bytes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("hello")),
    );
    const { text, isError } = await call(
      "get_file",
      { file_id: "f1", max_bytes: 1 },
      {},
      rawFetchClient(),
    );
    expect(isError).toBe(true);
    expect(text).toMatch(/exceeds max_bytes/);
  });

  it("accepts a file exactly at max_bytes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("hello")),
    );
    const { text, isError } = await call(
      "get_file",
      { file_id: "f1", max_bytes: 5 },
      {},
      rawFetchClient(),
    );
    expect(isError).toBe(false);
    expect(JSON.parse(text).bytes).toBe(5);
  });

  it("cancels an oversized Content-Length without reading the file body", async () => {
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(new Uint8Array(10));
    });
    const cancel = vi.fn();
    const body = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { headers: { "Content-Length": "10" } })),
    );
    const { text, isError } = await call(
      "get_file",
      { file_id: "f1", max_bytes: 5 },
      {},
      rawFetchClient(),
    );
    expect(isError).toBe(true);
    expect(text).toMatch(/exceeds max_bytes/);
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([{}, { "Content-Length": "1" }, { "Content-Encoding": "gzip" }])(
    "stops an oversized stream even without trustworthy length headers: %j",
    async (headers) => {
      const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
        controller.enqueue(new Uint8Array(3));
      });
      const cancel = vi.fn();
      const body = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(body, { headers })),
      );
      const { text, isError } = await call(
        "get_file",
        { file_id: "f1", max_bytes: 5 },
        {},
        rawFetchClient(),
      );
      expect(isError).toBe(true);
      expect(text).toMatch(/exceeds max_bytes/);
      expect(pull).toHaveBeenCalledTimes(2);
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it.each([true, false])(
    "does not retry an oversized download when cancellation fails (known length: %s)",
    async (knownLength) => {
      const fetch = vi.fn(async () => {
        const body = new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              controller.enqueue(new Uint8Array(6));
            },
            cancel() {
              return Promise.reject(new TypeError("connection closed during cancellation"));
            },
          },
          { highWaterMark: 0 },
        );
        return new Response(body, {
          headers: knownLength ? { "Content-Length": "6" } : undefined,
        });
      });
      vi.stubGlobal("fetch", fetch);
      const client = rawFetchClient();
      applyRequestResilience(client, { timeoutMs: 30_000, maxRetries: 3, baseDelayMs: 1 });
      const { text, isError } = await call("get_file", { file_id: "f1", max_bytes: 5 }, {}, client);
      expect(isError).toBe(true);
      expect(text).toMatch(/exceeds max_bytes/);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it("surfaces a non-ok response as Mattermost API error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Not found", { status: 404 })),
    );
    const { text, isError } = await call("get_file", { file_id: "gone" }, {}, rawFetchClient());
    expect(isError).toBe(true);
    expect(text).toMatch(/Mattermost API error 404/);
  });
});
