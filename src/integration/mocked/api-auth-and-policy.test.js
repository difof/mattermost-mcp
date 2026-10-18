import { ReadableStream } from "node:stream/web";
import mattermost from "@mattermost/client";
import { describe, expect, it, vi } from "vitest";
import { callApi } from "../../api/client.js";
import { resolveOperation } from "../../api/discovery.js";
import { applyRequestResilience } from "../../mattermost/resilience.js";
import { fetchFileContent, fetchFileMetadata } from "../../mattermost/files.js";
import { ME, OK, useMattermost } from "./mattermost-http-fixture.js";

const ID = "a".repeat(26);
const ACTIVATE = "GET /api/v4/access_control_policies/{policy_id}/activate";
const activation = { operation: ACTIVATE, path: { policy_id: ID }, query: { active: true } };
const reveal = { operation: "GET /api/v4/posts/{post_id}/reveal", path: { post_id: ID } };
const ping = { operation: "GET /api/v4/system/ping" };

describe("generic API access, error, and retry policy through MCP and HTTP", () => {
  const fixture = useMattermost();

  it("allows actual reads in read-only mode, including safe POST lookups, and blocks writes", async () => {
    const mm = fixture();
    mm.guardrails.readOnly = true;
    mm.expect("GET", `/users/${ID}`, { reply: { id: ID } });
    expect(
      await mm.call("api_call", {
        operation: "GET /api/v4/users/{user_id}",
        path: { user_id: ID },
      }),
    ).toMatchObject({ data: { id: ID } });
    mm.expect("POST", "/users/ids", { body: [ID], reply: [{ id: ID }] });
    expect(
      await mm.call("api_call", { operation: "POST /api/v4/users/ids", body: [ID] }),
    ).toMatchObject({ data: [{ id: ID }] });
    for (const args of [
      { operation: "POST /api/v4/posts", body: { channel_id: ID, message: "Blocked" } },
      activation,
      reveal,
      ping,
      // The server sends a magic-link email; a name containing 'type' is not a read.
      { operation: "POST /api/v4/users/login/type", body: { login_id: "casey@example.invalid" } },
    ]) {
      expect(await mm.error("api_call", { ...args, confirm: true })).toContain("read-only");
    }
    for (const args of [activation, reveal, ping]) {
      expect(await mm.call("api_describe", { operation: args.operation })).toMatchObject({
        policy: { write: true, destructive: args !== ping },
      });
    }
  });

  it("requires both destructive gates while ordinary message creation needs neither", async () => {
    const mm = fixture();
    const deletion = { operation: "DELETE /api/v4/posts/{post_id}", path: { post_id: ID } };
    const roles = {
      operation: "PUT /api/v4/users/{user_id}/roles",
      path: { user_id: ID },
      body: { roles: "system_user" },
    };
    for (const args of [deletion, roles, activation, reveal]) {
      expect(await mm.error("api_call", { ...args, confirm: true })).toContain(
        "MM_ALLOW_DESTRUCTIVE",
      );
    }
    const body = { channel_id: ID, message: "Ordinary post" };
    mm.expect("POST", "/posts", { body, status: 201, reply: { ...body, id: ID } });
    expect(await mm.call("api_call", { operation: "POST /api/v4/posts", body })).toMatchObject({
      status: 201,
    });
    mm.guardrails.allowDestructive = true;
    for (const args of [deletion, activation, reveal]) {
      expect(await mm.error("api_call", args)).toContain("confirm:true");
    }
    mm.expect("DELETE", `/posts/${ID}`, { reply: OK });
    expect(await mm.call("api_call", { ...deletion, confirm: true })).toMatchObject({ data: OK });
  });

  it.each(["teamAllowlist", "channelAllowlist"])(
    "blocks generic access under %s before HTTP while discovery and scoped tools remain usable",
    async (allowlist) => {
      const mm = fixture();
      mm.guardrails[allowlist] = [ID];
      const result = await mm.call("api_search", { query: "get user", limit: 1 });
      expect(result.operations).toHaveLength(1);
      for (const args of [
        { operation: "GET /api/v4/users/{user_id}", path: { user_id: ME.id } },
        { operation: "GET /api/v4/posts/{post_id}", path: { post_id: ID } },
        { operation: "POST /api/v4/posts/search", body: { terms: "visible" } },
      ]) {
        expect(await mm.error("api_call", args)).toContain("ALLOWLIST");
      }
      mm.expect("GET", "/users/me", { reply: ME });
      expect(await mm.call("get_me")).toEqual(ME);
    },
  );

  it("enforces message limits on JSON casing aliases, nested ephemeral posts, and raw-body bypasses", async () => {
    const mm = fixture();
    mm.guardrails.maxMessageLen = 3;
    const long = "😀".repeat(4);
    for (const body of [
      { channel_id: ID, message: long },
      { channel_id: ID, message: "ok", Message: long },
      { channel_id: ID, meſſage: long },
    ]) {
      expect(await mm.error("api_call", { operation: "POST /api/v4/posts", body })).toContain(
        "MM_MAX_MESSAGE_LEN",
      );
    }
    expect(
      await mm.error("api_call", {
        operation: "POST /api/v4/posts/ephemeral",
        body: { user_id: ME.id, Post: { channel_id: ID, Message: long } },
      }),
    ).toContain("MM_MAX_MESSAGE_LEN");
    expect(
      await mm.error("api_call", {
        operation: "POST /api/v4/posts",
        body_base64: Buffer.from(JSON.stringify({ channel_id: ID, message: long })).toString(
          "base64",
        ),
        content_type: "application/json",
      }),
    ).toContain("MM_MAX_MESSAGE_LEN");
    const body = { channel_id: ID, message: "😀".repeat(3) };
    mm.expect("POST", "/posts", { body, status: 201, reply: { ...body, id: ID } });
    expect(await mm.call("api_call", { operation: "POST /api/v4/posts", body })).toMatchObject({
      data: { message: body.message },
    });
  });

  it("rejects unknown operations, unsafe paths, encoding conflicts, and caller policy overrides", async () => {
    const mm = fixture();
    const invalid = [
      { operation: "GET https://example.invalid/api/v4/users" },
      { operation: "GET /api/v4/not_in_the_catalog" },
      { operation: "GET /api/v4/users/{user_id}" },
      { operation: "GET /api/v4/users/{user_id}", path: { user_id: ID, extra: "x" } },
      ...["..", "../users/me", "%2e%2e", "x\\y", "x\ny"].map((user_id) => ({
        operation: "GET /api/v4/users/{user_id}",
        path: { user_id },
      })),
      { operation: "GET /api/v4/users", method: "DELETE" },
      { operation: "GET /api/v4/users", baseURL: "https://example.invalid" },
      { operation: "GET /api/v4/users", retrySafe: true },
      { operation: "GET /api/v4/users", write: false },
      { operation: "GET /api/v4/users", body: {} },
      { operation: "GET /api/v4/users", query: { access_token: "different-account" } },
      { operation: "GET /api/v4/users", max_bytes: 0 },
      {
        operation: "POST /api/v4/uploads/{upload_id}",
        path: { upload_id: ID },
        body_base64: "not-base64!",
      },
      {
        operation: "POST /api/v4/uploads/{upload_id}",
        path: { upload_id: ID },
        body: {},
        body_base64: "eA==",
      },
      {
        operation: "POST /api/v4/uploads/{upload_id}",
        path: { upload_id: ID },
        body_base64: "eA==",
        content_type: "application/javascript",
      },
      {
        operation: "POST /api/v4/files",
        files: [{ field: "files", filename: "bad.bin", content_base64: "%%%" }],
      },
    ];
    for (const args of invalid) {
      expect(await mm.error("api_call", args), JSON.stringify(args)).toMatch(
        /unknown|missing|invalid|cannot|not accept|base64|supported|exclusive/i,
      );
    }
  });

  it("prevents credential/header overrides and excludes token-bearing response headers", async () => {
    const mm = fixture();
    for (const name of [
      "Authorization",
      "authorization",
      "Cookie",
      "Host",
      "Content-Type",
      "Content-Length",
      "Proxy-Authorization",
      "X-Forwarded-For",
      "X-Unknown-Header",
    ]) {
      expect(
        await mm.error("api_call", {
          operation: "GET /api/v4/users/{user_id}",
          path: { user_id: ME.id },
          headers: { [name]: "override" },
        }),
        name,
      ).toContain("header");
    }
    mm.expect("GET", `/users/${ME.id}`, {
      reply: ME,
      requestHeaders: { accept: "application/json" },
      headers: {
        Token: "new-secret",
        "Set-Cookie": "MMAUTHTOKEN=cookie-secret",
        Authorization: "Bearer reflected-secret",
        "X-Request-Id": "trace-id",
      },
    });
    const result = await mm.call("api_call", {
      operation: "GET /api/v4/users/{user_id}",
      path: { user_id: ME.id },
      headers: { Accept: "application/json" },
    });
    expect(result).toMatchObject({ data: ME, headers: { "x-request-id": "trace-id" } });
    expect(JSON.stringify(result)).not.toMatch(/new-secret|cookie-secret|reflected-secret/);
  });

  it("returns same-origin and external redirects without following either Location", async () => {
    const mm = fixture();
    for (const location of [
      `${mm.url}/api/v4/unplanned`,
      "https://outside.example.invalid/collect",
    ]) {
      mm.expect("GET", `/files/${ID}`, {
        status: 302,
        empty: true,
        headers: { Location: location },
        fetchRedirect: "manual",
      });
      expect(
        await mm.call("api_call", {
          operation: "GET /api/v4/files/{file_id}",
          path: { file_id: ID },
        }),
      ).toMatchObject({ status: 302, data: null, headers: { location } });
    }
    // The fixture fails on a second request and validates redirect:'manual'
    // before native fetch, so an implementation regression cannot leave localhost.
  });

  it("retains HTTP status and original AppError/proxy details, including an empty 404", async () => {
    const mm = fixture();
    const cases = [
      {
        status: 401,
        message: "Expired PAT",
        reply: { status_code: 401, id: "api.context.session_expired", message: "Expired PAT" },
      },
      // A proxy or inconsistent body must not override the real HTTP status.
      {
        status: 403,
        message: "Missing read_channel permission",
        reply: {
          status_code: 200,
          id: "api.context.permissions",
          message: "Missing read_channel permission",
          detailed_error: "channel_id=" + ID,
        },
      },
      { status: 404, message: "Not Found", empty: true },
      {
        status: 403,
        message: "Forbidden by proxy",
        bytes: Buffer.from("Forbidden by proxy"),
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      },
    ];
    for (const { message, ...response } of cases) {
      mm.expect("GET", `/channels/${ID}/join_request`, {
        headers: { "Content-Type": "application/json; charset=utf-8" },
        ...response,
      });
      const error = await mm.error("api_call", {
        operation: "GET /api/v4/channels/{channel_id}/join_request",
        path: { channel_id: ID },
      });
      expect(error).toContain(String(response.status));
      expect(error).toContain(message);
      if (response.reply?.id) expect(error).toContain(response.reply.id);
      if (response.reply?.detailed_error) expect(error).toContain(response.reply.detailed_error);
    }
  });

  it("retries transient GET and source-verified read-only POST requests with unchanged bodies", async () => {
    const mm = fixture();
    mm.expect("GET", `/users/${ID}`, {
      status: 503,
      bytes: Buffer.from("proxy temporarily unavailable"),
      headers: { "Content-Type": "text/plain" },
    });
    mm.expect("GET", `/users/${ID}`, { reply: { id: ID } });
    expect(
      await mm.call("api_call", {
        operation: "GET /api/v4/users/{user_id}",
        path: { user_id: ID },
      }),
    ).toMatchObject({ data: { id: ID } });
    mm.expect("POST", "/users/ids", {
      body: [ID],
      status: 429,
      reply: { status_code: 429, message: "Rate limited" },
    });
    mm.expect("POST", "/users/ids", { body: [ID], reply: [{ id: ID }] });
    expect(
      await mm.call("api_call", { operation: "POST /api/v4/users/ids", body: [ID] }),
    ).toMatchObject({ data: [{ id: ID }] });
  });

  it.each([
    {
      operation: "POST /api/v4/posts",
      method: "POST",
      url: "/posts",
      body: { channel_id: ID, message: "Once" },
    },
    {
      operation: "PUT /api/v4/posts/{post_id}/patch",
      method: "PUT",
      url: `/posts/${ID}/patch`,
      path: { post_id: ID },
      body: { message: "Edit once" },
    },
    {
      operation: "DELETE /api/v4/posts/{post_id}",
      method: "DELETE",
      url: `/posts/${ID}`,
      path: { post_id: ID },
    },
    { ...activation, method: "GET", url: `/access_control_policies/${ID}/activate` },
    { ...reveal, method: "GET", url: `/posts/${ID}/reveal` },
    { ...ping, method: "GET", url: "/system/ping" },
  ])("never replays ambiguous writes: $operation", async ({ method, url, ...args }) => {
    const mm = fixture();
    mm.guardrails.allowDestructive = true;
    mm.expect(method, url, {
      ...(Object.hasOwn(args, "body") ? { body: args.body } : {}),
      query: args.query,
      status: 503,
      reply: { status_code: 503, message: "Operation outcome unavailable" },
    });
    expect(await mm.error("api_call", { ...args, confirm: true })).toContain("503");
    // A retry would be an unplanned HTTP request and fail the fixture.
  });
});

// Inject the broken stream directly while keeping Client4 and the recovery runner real.
it.each([
  {
    name: "generic API",
    path: `/users/${ID}`,
    request: (client) =>
      callApi(client, resolveOperation("GET /api/v4/users/{user_id}"), { path: { user_id: ID } }),
    expected: { status: 200, data: { id: ID } },
  },
  {
    name: "file metadata",
    path: `/files/${ID}/info`,
    request: (client) => fetchFileMetadata(client, ID),
    expected: { id: ID },
  },
  {
    name: "file download",
    path: `/files/${ID}`,
    request: (client) => fetchFileContent(client, ID, 1024),
    expected: Buffer.from(JSON.stringify({ id: ID })),
  },
])(
  "recovers $name once when a received 401 response's body stream fails",
  async ({ path, request, expected }) => {
    const client = new mattermost.Client4();
    client.setUrl("https://mattermost.example.invalid/mattermost");
    client.setToken("expired-test-token");
    client.setIncludeCookies(false);
    const recover = vi.fn(async () => {
      client.setToken("refreshed-test-token");
      return true;
    });
    // Disabling transient retries proves the second request comes from 401 recovery.
    applyRequestResilience(client, { timeoutMs: 2000, maxRetries: 0, baseDelayMs: 0 }, recover);
    const brokenBody = new ReadableStream({
      start(controller) {
        controller.error(new TypeError("connection lost while reading the error body"));
      },
    });
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected additional request"))
      .mockResolvedValueOnce(new globalThis.Response(brokenBody, { status: 401 }))
      .mockResolvedValueOnce(globalThis.Response.json({ id: ID }));
    try {
      await expect(request(client)).resolves.toMatchObject(expected);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(recover).toHaveBeenCalledOnce();
      for (const [index, token] of ["expired-test-token", "refreshed-test-token"].entries()) {
        const [url, options] = fetch.mock.calls[index];
        expect(url).toBe(`https://mattermost.example.invalid/mattermost/api/v4${path}`);
        expect(options.method.toUpperCase()).toBe("GET");
        expect(options.redirect).toBe("manual");
        expect(new Headers(options.headers).get("authorization")).toMatch(
          new RegExp(`^Bearer ${token}$`, "i"),
        );
      }
    } finally {
      fetch.mockRestore();
    }
  },
);
