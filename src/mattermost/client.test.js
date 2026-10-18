import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import mattermost from "@mattermost/client";
import { createSession, doClientFetch } from "./client.js";
import { runClientRequest } from "./resilience.js";
const oauth = vi.hoisted(() => ({
  acquireOAuthToken: vi.fn(),
  refreshOAuthToken: vi.fn(),
}));
vi.mock("./oauth.js", () => oauth);
const me = { id: "me1", username: "mzar" };
function config(auth = { mode: "pat", token: "personal-token" }) {
  return {
    url: "http://mm.test",
    auth,
    guardrails: {
      readOnly: false,
      allowDestructive: false,
      teamAllowlist: [],
      channelAllowlist: [],
      maxMessageLen: 16383,
    },
    resilience: { timeoutMs: 0, maxRetries: 3, baseDelayMs: 1 },
  };
}
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
function failure(status) {
  return json({ message: "request failed", status_code: status }, status);
}
/** Exercise the real SDK transport; only the HTTP boundary is mocked. */
function mockApi(operation) {
  const api = vi.fn(operation);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, options) => {
      if (new URL(url).pathname.endsWith("/users/me")) return json(me);
      return api(url, options);
    }),
  );
  return api;
}
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});
describe("session HTTP request resilience", () => {
  it("retries a failed GET without rerunning the callback", async () => {
    let attempts = 0;
    const api = mockApi((_url, options) => {
      expect(new Headers(options.headers).get("Authorization")).toBe("BEARER personal-token");
      return ++attempts === 1 ? failure(503) : json({ id: "p1" });
    });
    const session = await createSession(config());
    const callback = vi.fn((c) => c.getPost("p1"));
    await expect(session.call(callback)).resolves.toMatchObject({ id: "p1" });
    expect(session.userId).toBe(me.id);
    expect(callback).toHaveBeenCalledOnce();
    expect(api).toHaveBeenCalledTimes(2);
  });
  const searches = [
    { name: "user search", read: (c) => c.searchUsers("alice", {}) },
    { name: "team post search", read: (c) => c.searchPosts("team1", "deploy", false) },
    { name: "all-team post search", read: (c) => c.searchPosts("", "deploy", false) },
  ];
  it.each(searches)("retains retries for read-only POST $name", async ({ read }) => {
    let attempts = 0;
    const api = mockApi((_url, options) => {
      expect(options.method).toBe("post");
      return ++attempts === 1 ? failure(429) : json([]);
    });
    const cfg = config();
    // Ensure read-only route recognition supports a Mattermost subpath.
    cfg.url = "http://mm.test/mattermost";
    const session = await createSession(cfg);
    await expect(session.call(read)).resolves.toEqual([]);
    expect(api).toHaveBeenCalledTimes(2);
  });
  it.each([429, 500, 503, "network", "timeout"])(
    "does not resend a post after an ambiguous %s failure",
    async (reason) => {
      const api = mockApi(() => {
        if (reason === "network") throw new TypeError("fetch failed");
        if (reason === "timeout") throw new DOMException("request timed out", "TimeoutError");
        return failure(reason);
      });
      const session = await createSession(config());
      await expect(
        session.call((c) => c.createPost({ channel_id: "c1", message: "send once" })),
      ).rejects.toThrow();
      expect(api).toHaveBeenCalledOnce();
    },
  );
  const writes = [
    { name: "post edit", write: (c) => c.patchPost({ id: "p1", message: "updated" }) },
    { name: "post deletion", write: (c) => c.deletePost("p1") },
    { name: "file upload", write: (c) => c.uploadFile(new FormData()) },
  ];
  it.each(writes)("does not replay $name after a server failure", async ({ write }) => {
    const api = mockApi(() => failure(503));
    const session = await createSession(config());
    await expect(session.call(write)).rejects.toMatchObject({ status_code: 503 });
    expect(api).toHaveBeenCalledOnce();
  });
  it("does not repeat a completed write when a later read in the callback fails", async () => {
    let writes = 0;
    let reads = 0;
    mockApi((_url, options) => {
      if (options.method === "post") {
        writes++;
        return json({ id: "p1" });
      }
      return ++reads === 1 ? failure(503) : json({ id: "p1", message: "saved" });
    });
    const session = await createSession(config());
    await expect(
      session.call(async (c) => {
        const post = await c.createPost({ channel_id: "c1", message: "saved" });
        return c.getPost(post.id);
      }),
    ).resolves.toMatchObject({ message: "saved" });
    expect(writes).toBe(1);
    expect(reads).toBe(2);
  });
  it("does not retry a callback's own TypeError after a successful write", async () => {
    const api = mockApi(() => json({ id: "p1" }));
    const session = await createSession(config());
    await expect(
      session.call(async (c) => {
        await c.createPost({ channel_id: "c1", message: "saved" });
        throw new TypeError("post-processing failed");
      }),
    ).rejects.toThrow("post-processing failed");
    expect(api).toHaveBeenCalledOnce();
  });
  it("honors zero read retries", async () => {
    const api = mockApi(() => failure(503));
    const cfg = config();
    cfg.resilience.maxRetries = 0;
    const session = await createSession(cfg);
    await expect(session.call((c) => c.getPost("p1"))).rejects.toMatchObject({ status_code: 503 });
    expect(api).toHaveBeenCalledOnce();
  });
  it("creates a fresh timeout signal for a retried HTTP read", async () => {
    const signals = [];
    mockApi((_url, options) => {
      signals.push(options.signal);
      if (signals.length === 1) throw new DOMException("request timed out", "TimeoutError");
      return json({ id: "p1" });
    });
    const cfg = config();
    cfg.resilience.timeoutMs = 5000;
    const session = await createSession(cfg);
    await expect(session.call((c) => c.getPost("p1"))).resolves.toMatchObject({ id: "p1" });
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[1]).not.toBe(signals[0]);
  });
  it("shares safe read retries with the binary transport helper", async () => {
    mockApi(() => json({}));
    const session = await createSession(config());
    const operation = vi
      .fn()
      .mockRejectedValueOnce(
        new mattermost.ClientError(config().url, { message: "busy", status_code: 503 }),
      )
      .mockResolvedValue(Buffer.from("file"));
    await expect(
      runClientRequest(
        session.client,
        `${config().url}/api/v4/files/f1`,
        { method: "get" },
        operation,
      ),
    ).resolves.toEqual(Buffer.from("file"));
    expect(operation).toHaveBeenCalledTimes(2);
  });
  it("retains SDK auth, parsing, and retries for the verified-route helper", async () => {
    let attempts = 0;
    const api = mockApi((url, options) => {
      expect(url).toBe("http://mm.test/api/v4/users/me/channels");
      expect(new Headers(options.headers).get("Authorization")).toBe("BEARER personal-token");
      return ++attempts === 1 ? failure(503) : json([{ id: "dm1", type: "D" }]);
    });
    const session = await createSession(config());
    await expect(
      session.call((c) => doClientFetch(c, `${c.getUserRoute("me")}/channels`, { method: "get" })),
    ).resolves.toEqual([{ id: "dm1", type: "D" }]);
    expect(api).toHaveBeenCalledTimes(2);
  });
  it("does not retry an explicitly cancelled read", async () => {
    mockApi(() => json({}));
    const session = await createSession(config());
    const controller = new AbortController();
    const operation = vi.fn(async () => {
      controller.abort();
      throw new DOMException("cancelled", "AbortError");
    });
    await expect(
      runClientRequest(
        session.client,
        `${config().url}/api/v4/files/f1`,
        { method: "get", signal: controller.signal },
        operation,
      ),
    ).rejects.toThrow("cancelled");
    expect(operation).toHaveBeenCalledOnce();
  });
});
describe("per-request authentication recovery", () => {
  const password = { mode: "password", loginId: "mzar", password: "test-password" };
  it("refreshes a rejected cached OAuth token during startup identity verification", async () => {
    oauth.acquireOAuthToken.mockResolvedValue({
      accessToken: "rejected-cache",
      refreshToken: "valid-refresh",
      tokenType: "Bearer",
    });
    oauth.refreshOAuthToken.mockResolvedValue({ accessToken: "fresh-token", tokenType: "Bearer" });
    const fetch = vi.fn(async (_url, options) =>
      new Headers(options.headers).get("Authorization") === "BEARER fresh-token"
        ? json(me)
        : failure(401),
    );
    vi.stubGlobal("fetch", fetch);
    const cfg = config({
      mode: "oauth2",
      clientId: "client",
      clientSecret: "secret",
      redirect: "http://127.0.0.1:7000/callback",
    });
    const session = await createSession(cfg);
    expect(session.userId).toBe(me.id);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(oauth.acquireOAuthToken).toHaveBeenCalledWith(
      cfg.url,
      cfg.auth,
      cfg.resilience.timeoutMs,
    );
    expect(oauth.refreshOAuthToken).toHaveBeenCalledOnce();
    expect(oauth.refreshOAuthToken).toHaveBeenCalledWith(
      cfg.url,
      cfg.auth,
      { accessToken: "rejected-cache", refreshToken: "valid-refresh", tokenType: "Bearer" },
      cfg.resilience.timeoutMs,
    );
  });
  it("recovers the rejected request without replaying an earlier write", async () => {
    let logins = 0;
    let writes = 0;
    let reads = 0;
    mockApi((url, options) => {
      if (url.endsWith("/users/login")) return json(me, 200, { Token: `token-${++logins}` });
      if (options.method === "post") {
        writes++;
        return json({ id: "p1" });
      }
      if (++reads === 1) return failure(401);
      expect(new Headers(options.headers).get("Authorization")).toBe("BEARER token-2");
      return json({ id: "p1" });
    });
    const session = await createSession(config(password));
    await expect(
      session.call(async (c) => {
        const post = await c.createPost({ channel_id: "c1", message: "saved" });
        return c.getPost(post.id);
      }),
    ).resolves.toMatchObject({ id: "p1" });
    expect(logins).toBe(2);
    expect(writes).toBe(1);
    expect(reads).toBe(2);
  });
  it("stops after one rejected password recovery instead of recursively logging in", async () => {
    let logins = 0;
    const api = mockApi((url) => {
      if (url.endsWith("/users/login") && ++logins === 1) {
        return json(me, 200, { Token: "expired-token" });
      }
      return failure(401);
    });
    const session = await createSession(config(password));
    await expect(session.call((c) => c.getPost("p1"))).rejects.toMatchObject({ status_code: 401 });
    expect(logins).toBe(2);
    expect(api).toHaveBeenCalledTimes(3); // Initial login, failed read, failed recovery.
  });
  it("propagates an invalid PAT without retrying or attempting login", async () => {
    const api = mockApi(() => failure(401));
    const session = await createSession(config());
    await expect(session.call((c) => c.getPost("p1"))).rejects.toMatchObject({ status_code: 401 });
    expect(api).toHaveBeenCalledOnce();
  });
  it("preserves a failed login response instead of retrying the read with an expired token", async () => {
    let logins = 0;
    const api = mockApi((url) => {
      if (url.endsWith("/users/login")) {
        return ++logins === 1 ? json(me, 200, { Token: "expired-token" }) : failure(503);
      }
      return failure(401);
    });
    const session = await createSession(config(password));
    await expect(session.call((c) => c.getPost("p1"))).rejects.toMatchObject({ status_code: 503 });
    expect(api).toHaveBeenCalledTimes(3);
    expect(logins).toBe(2);
  });
  it("retries a rejected write once after login, but stops on its subsequent server failure", async () => {
    let logins = 0;
    let writes = 0;
    mockApi((url) => {
      if (url.endsWith("/users/login")) return json(me, 200, { Token: `token-${++logins}` });
      return ++writes === 1 ? failure(401) : failure(503);
    });
    const session = await createSession(config(password));
    await expect(
      session.call((c) => c.createPost({ channel_id: "c1", message: "send once" })),
    ).rejects.toMatchObject({ status_code: 503 });
    expect(logins).toBe(2);
    expect(writes).toBe(2);
  });
  it("shares one OAuth refresh across concurrent rejected requests", async () => {
    oauth.acquireOAuthToken.mockResolvedValue({
      accessToken: "expired-token",
      refreshToken: "refresh-once",
      tokenType: "Bearer",
    });
    let finishRefresh;
    oauth.refreshOAuthToken.mockReturnValue(
      new Promise((resolve) => {
        finishRefresh = resolve;
      }),
    );
    const api = mockApi((_url, options) =>
      new Headers(options.headers).get("Authorization") === "BEARER expired-token"
        ? failure(401)
        : json({ id: "p1" }),
    );
    const session = await createSession(
      config({
        mode: "oauth2",
        clientId: "client",
        clientSecret: "secret",
        redirect: "http://127.0.0.1:7000/callback",
      }),
    );
    const reads = Promise.all([
      session.call((c) => c.getPost("p1")),
      session.call((c) => c.getPost("p2")),
    ]);
    await vi.waitFor(() => expect(oauth.refreshOAuthToken).toHaveBeenCalledOnce());
    finishRefresh({ accessToken: "new-token", refreshToken: "rotated-token", tokenType: "Bearer" });
    await expect(reads).resolves.toHaveLength(2);
    expect(oauth.refreshOAuthToken).toHaveBeenCalledOnce();
    expect(api).toHaveBeenCalledTimes(4);
  });
});
