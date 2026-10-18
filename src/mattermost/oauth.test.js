import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import {
  pkcePair,
  buildAuthorizeUrl,
  parseTokenResponse,
  isTokenExpired,
  tokenCacheFile,
  readTokenCache,
  writeTokenCache,
  refreshOAuthToken,
  waitForCode,
} from "./oauth.js";
const http = vi.hoisted(() => ({ createServer: vi.fn() }));
vi.mock("node:http", () => http);

let directory;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "mm-oauth-test-"));
  vi.stubEnv("XDG_CONFIG_HOME", directory);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
  rmSync(directory, { recursive: true, force: true });
});
const b64url = (buf) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
describe("pkcePair", () => {
  it("produces a url-safe 43-char verifier", () => {
    const { verifier } = pkcePair();
    expect(verifier).toHaveLength(43); // base64url(32 bytes), unpadded
    expect(verifier).toMatch(/^[A-Za-z0-9\-_]+$/);
  });
  it("derives the challenge as base64url(sha256(verifier))", () => {
    const { verifier, challenge } = pkcePair();
    expect(challenge).toBe(b64url(createHash("sha256").update(verifier).digest()));
  });
  it("is random per call", () => {
    expect(pkcePair().verifier).not.toBe(pkcePair().verifier);
  });
});
describe("buildAuthorizeUrl", () => {
  it("targets {url}/oauth/authorize with required + PKCE params", () => {
    const u = new URL(
      buildAuthorizeUrl(
        "https://mm.example.com",
        "cid",
        "http://127.0.0.1:7000/callback",
        "st8",
        "chal",
      ),
    );
    expect(u.origin + u.pathname).toBe("https://mm.example.com/oauth/authorize");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("client_id")).toBe("cid");
    expect(u.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:7000/callback");
    expect(u.searchParams.get("state")).toBe("st8");
    expect(u.searchParams.get("code_challenge")).toBe("chal");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
  });
});
describe("parseTokenResponse", () => {
  it("maps a full response and computes expiresAt", () => {
    const now = 1_000_000;
    const t = parseTokenResponse(
      {
        access_token: "at",
        refresh_token: "rt",
        token_type: "bearer",
        scope: "user",
        expires_in: 3600,
      },
      now,
    );
    expect(t).toEqual({
      accessToken: "at",
      refreshToken: "rt",
      tokenType: "bearer",
      scope: "user",
      expiresAt: now + 3600 * 1000,
    });
  });
  it("defaults token_type and omits expiresAt when expires_in absent", () => {
    const t = parseTokenResponse({ access_token: "at" }, 0);
    expect(t).toEqual({ accessToken: "at", tokenType: "Bearer" });
  });
  it("coerces a string expires_in", () => {
    const t = parseTokenResponse({ access_token: "at", expires_in: "120" }, 0);
    expect(t.expiresAt).toBe(120 * 1000);
  });
  it("rejects a body without access_token", () => {
    expect(() => parseTokenResponse({ token_type: "bearer" }, 0)).toThrow();
  });
});
describe("isTokenExpired", () => {
  const base = { accessToken: "at", tokenType: "Bearer" };
  it("never expires without an expiresAt", () => {
    expect(isTokenExpired(base, 9_999_999)).toBe(false);
  });
  it("is fresh well before expiry", () => {
    expect(isTokenExpired({ ...base, expiresAt: 1_000_000 }, 500_000)).toBe(false);
  });
  it("is expired within the 60s safety margin", () => {
    const expiresAt = 1_000_000;
    expect(isTokenExpired({ ...base, expiresAt }, expiresAt - 30_000)).toBe(true);
    expect(isTokenExpired({ ...base, expiresAt }, expiresAt + 1)).toBe(true);
  });
});
describe("tokenCacheFile", () => {
  it("is deterministic, hashed, and under mattermost-mcp", () => {
    const a = tokenCacheFile("https://mm.example.com", "cid");
    const b = tokenCacheFile("https://mm.example.com", "cid");
    expect(a).toBe(b);
    expect(a).toMatch(/mattermost-mcp\/oauth-[0-9a-f]{16}\.json$/);
    expect(a).not.toContain("cid"); // client id not leaked into the path
  });
  it("differs per server and per client", () => {
    expect(tokenCacheFile("https://a.example", "c")).not.toBe(
      tokenCacheFile("https://b.example", "c"),
    );
    expect(tokenCacheFile("https://a.example", "c1")).not.toBe(
      tokenCacheFile("https://a.example", "c2"),
    );
  });
});
describe("token cache read/write", () => {
  it("replaces an existing cache with private, round-trippable tokens", () => {
    const file = join(directory, "oauth.json");
    writeFileSync(file, "old cache");
    chmodSync(file, 0o644);
    const tokens = {
      accessToken: "at",
      refreshToken: "rt",
      tokenType: "Bearer",
      scope: "user",
      expiresAt: 42,
    };
    writeTokenCache(file, tokens);
    expect(readTokenCache(file)).toEqual(tokens);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
  it("returns null for a missing cache", () => {
    expect(readTokenCache(join(directory, "missing.json"))).toBeNull();
  });
});

describe("OAuth token requests", () => {
  const url = "https://mm.example.com";
  const auth = { clientId: "client", clientSecret: "dummy-secret" };
  const current = { accessToken: "old", refreshToken: "refresh", tokenType: "Bearer" };

  it("rejects redirects without forwarding the client secret or replaying the refresh", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(null, {
          status: 307,
          headers: { Location: "https://other.example.com/token" },
        }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(refreshOAuthToken(url, auth, current)).rejects.toThrow(
      "OAuth token endpoint 307: redirects are not allowed",
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe(`${url}/oauth/access_token`);
    expect(fetch.mock.calls[0][1].redirect).toBe("manual");
    expect(readTokenCache(tokenCacheFile(url, auth.clientId))).toBeNull();
  });

  it("aborts a stalled token request at its configured deadline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      ),
    );
    await expect(refreshOAuthToken(url, auth, current, 10)).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  it("dates refreshed tokens from the response time and honors disabled deadlines", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const fetch = vi.fn(async () => {
      vi.setSystemTime(1_120_000);
      return Response.json({ access_token: "fresh", expires_in: 120 });
    });
    vi.stubGlobal("fetch", fetch);
    const result = await refreshOAuthToken(url, auth, current, 0);
    expect(result).toMatchObject({
      accessToken: "fresh",
      refreshToken: "refresh",
      expiresAt: 1_240_000,
    });
    expect(fetch.mock.calls[0][1].signal).toBeUndefined();
    expect(readTokenCache(tokenCacheFile(url, auth.clientId))).toEqual(result);
  });

  it("decodes a UTF-8 BOM before parsing a token response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('\uFEFF{"access_token":"fresh"}')),
    );
    await expect(refreshOAuthToken(url, auth, current)).resolves.toMatchObject({
      accessToken: "fresh",
    });
  });

  it("bounds token error bodies while retaining their HTTP status", async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array(1024 * 1024 + 1), { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    await expect(refreshOAuthToken(url, auth, current)).rejects.toThrow(
      "OAuth token endpoint 503: OAuth token response exceeds 1048576 bytes",
    );
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe("loopback callback", () => {
  it.each([
    ["http://127.0.0.1:7000/callback", "127.0.0.1"],
    ["http://[::1]:7000/callback", "::1"],
    ["http://localhost:7000/callback", "localhost"],
  ])("binds the host named by %s and accepts the matching callback", async (redirect, host) => {
    let handler;
    const server = new EventEmitter();
    server.listen = vi.fn();
    server.close = vi.fn();
    http.createServer.mockImplementation((callback) => {
      handler = callback;
      return server;
    });
    const code = waitForCode(redirect, "expected-state");
    expect(server.listen).toHaveBeenCalledWith(7000, host);
    const response = { writeHead: vi.fn().mockReturnThis(), end: vi.fn() };
    handler({ url: "/callback?state=expected-state&code=authorization-code" }, response);
    await expect(code).resolves.toBe("authorization-code");
    expect(server.close).toHaveBeenCalledOnce();
  });

  it("rejects unsupported redirects before creating a listener", () => {
    expect(() => waitForCode("https://127.0.0.1:7000/callback", "state")).toThrow(
      /HTTP loopback OAuth redirect/,
    );
    expect(http.createServer).not.toHaveBeenCalled();
  });
});
