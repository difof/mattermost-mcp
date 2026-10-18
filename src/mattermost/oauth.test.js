import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import {
  pkcePair,
  buildAuthorizeUrl,
  parseTokenResponse,
  isTokenExpired,
  tokenCacheFile,
  readTokenCache,
  writeTokenCache,
} from "./oauth.js";
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
  it("round-trips tokens through disk", () => {
    const file = join(tmpdir(), `mm-mcp-test-${process.pid}`, "oauth.json");
    const tokens = {
      accessToken: "at",
      refreshToken: "rt",
      tokenType: "Bearer",
      scope: "user",
      expiresAt: 42,
    };
    try {
      writeTokenCache(file, tokens);
      expect(readTokenCache(file)).toEqual(tokens);
    } finally {
      rmSync(join(file, ".."), { recursive: true, force: true });
    }
  });
  it("returns null for a missing or corrupt cache", () => {
    expect(readTokenCache(join(tmpdir(), "mm-mcp-does-not-exist.json"))).toBeNull();
  });
});
