// OAuth2 authorization-code flow (with PKCE S256 + refresh) for headless MCP.
//
// Mattermost OAuth2 web routes live OUTSIDE /api/v4 ({MM_URL}/oauth/authorize and
// {MM_URL}/oauth/access_token), and Client4 exposes no method for the token
// endpoint — so this module talks to them with the global `fetch` directly.
// Verified: getOAuthRoute() === `${url}/oauth`; the server honors PKCE
// (code_challenge / code_challenge_method, see client4.js authorizeOAuthApp).
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { configDir } from "../paths.js";
import { log } from "../log.js";
const USER_AGENT = "mattermost-mcp/0.1.0";
const CONSENT_TIMEOUT_MS = 300_000; // 5 min for the user to log in + consent
const EXPIRY_MARGIN_MS = 60_000; // treat a token as expired 60s early
// --- PKCE --------------------------------------------------------------------
function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/** Fresh PKCE pair: 43-char base64url verifier + its S256 challenge. */
export function pkcePair() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}
// --- Authorize URL -----------------------------------------------------------
export function buildAuthorizeUrl(url, clientId, redirect, state, challenge) {
  const u = new URL(`${url}/oauth/authorize`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirect);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}
// --- Token endpoint ----------------------------------------------------------
const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.coerce.number().int().nonnegative().optional(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
});
/** Validate a raw token-endpoint JSON body and normalize its token fields. */
export function parseTokenResponse(json, now) {
  const r = TokenResponseSchema.parse(json);
  return {
    accessToken: r.access_token,
    ...(r.refresh_token ? { refreshToken: r.refresh_token } : {}),
    tokenType: r.token_type ?? "Bearer",
    ...(r.scope ? { scope: r.scope } : {}),
    ...(r.expires_in != null ? { expiresAt: now + r.expires_in * 1000 } : {}),
  };
}
async function postToken(url, body, now) {
  const res = await fetch(`${url}/oauth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    // Surface the server response verbatim (status + body).
    throw new Error(`OAuth token endpoint ${res.status}: ${text}`);
  }
  return parseTokenResponse(JSON.parse(text), now);
}
function exchangeCode(url, auth, code, verifier, now) {
  return postToken(
    url,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: auth.clientId,
      client_secret: auth.clientSecret,
      redirect_uri: auth.redirect,
      code_verifier: verifier,
    }),
    now,
  );
}
function refresh(url, auth, refreshToken, now) {
  return postToken(
    url,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: auth.clientId,
      client_secret: auth.clientSecret,
    }),
    now,
  );
}
// --- Token cache (OS config dir, 0600) ---------------------------------------
/** Per-(server, client) cache path. Keyed by a hash to avoid leaking either. */
export function tokenCacheFile(url, clientId) {
  const key = createHash("sha256").update(`${url}|${clientId}`).digest("hex").slice(0, 16);
  return join(configDir(), `oauth-${key}.json`);
}
const CachedTokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().optional(),
  tokenType: z.string(),
  scope: z.string().optional(),
  expiresAt: z.number().optional(),
});
export function readTokenCache(file) {
  try {
    return CachedTokensSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null; // missing or corrupt cache → re-authenticate
  }
}
export function writeTokenCache(file, tokens) {
  mkdirSync(join(file, ".."), { recursive: true });
  // 0600: the file holds access + refresh tokens.
  writeFileSync(file, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}
/** True when the token is absent of expiry-safety, i.e. expired (or within margin). */
export function isTokenExpired(tokens, now) {
  return tokens.expiresAt != null && now > tokens.expiresAt - EXPIRY_MARGIN_MS;
}
// --- Interactive consent (loopback redirect catcher) -------------------------
function openBrowser(url) {
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : null;
  if (!opener) return; // print-only on other platforms
  try {
    const child = spawn(opener, [url], { stdio: "ignore", detached: true });
    child.on("error", () => {}); // best-effort; URL is also printed
    child.unref();
  } catch {
    // ignore — the URL was logged for manual opening
  }
}
/** Start a loopback server on the redirect URI and resolve with the auth `code`. */
function waitForCode(redirect, expectedState) {
  const target = new URL(redirect);
  const port = Number(target.port || "80");
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const reqUrl = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (reqUrl.pathname !== target.pathname) {
        res.writeHead(404).end("not found");
        return;
      }
      const reply = (msg) => {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!doctype html><meta charset=utf-8><body>${msg} You can close this tab.</body>`);
      };
      const fail = (browserMsg, err) => {
        reply(browserMsg);
        finish();
        reject(err);
      };
      const error = reqUrl.searchParams.get("error");
      const code = reqUrl.searchParams.get("code");
      const state = reqUrl.searchParams.get("state");
      if (error)
        return fail("Authorization failed.", new Error(`OAuth authorization error: ${error}`));
      if (state !== expectedState)
        return fail("State mismatch.", new Error("OAuth state mismatch (possible CSRF)"));
      if (!code)
        return fail("Missing code.", new Error("OAuth callback missing authorization code"));
      reply("Authorization complete.");
      finish();
      resolve(code);
    });
    const timer = setTimeout(() => {
      finish();
      reject(new Error(`OAuth consent timed out after ${CONSENT_TIMEOUT_MS / 1000}s`));
    }, CONSENT_TIMEOUT_MS);
    timer.unref();
    function finish() {
      clearTimeout(timer);
      server.close();
    }
    server.on("error", (err) => {
      finish();
      reject(err);
    });
    server.listen(port, "127.0.0.1");
  });
}
async function interactiveConsent(url, auth, now) {
  const state = base64url(randomBytes(16));
  const { verifier, challenge } = pkcePair();
  const authorizeUrl = buildAuthorizeUrl(url, auth.clientId, auth.redirect, state, challenge);
  // Listen BEFORE opening the browser so the redirect is never missed.
  const codePromise = waitForCode(auth.redirect, state);
  log(`oauth2 consent required — open this URL in your browser:\n${authorizeUrl}`);
  openBrowser(authorizeUrl);
  const code = await codePromise;
  return exchangeCode(url, auth, code, verifier, now);
}
// --- Public API --------------------------------------------------------------
/**
 * Obtain a usable access token: cache-first, refresh if expired, else run the
 * interactive consent flow. Persists the result to the token cache.
 */
export async function acquireOAuthToken(url, auth) {
  const file = tokenCacheFile(url, auth.clientId);
  const cached = readTokenCache(file);
  if (cached && !isTokenExpired(cached, Date.now())) {
    return cached;
  }
  if (cached?.refreshToken) {
    try {
      const refreshed = await refreshOAuthToken(url, auth, cached);
      log("oauth2 access token refreshed from cache");
      return refreshed;
    } catch (err) {
      log(`oauth2 refresh failed (${errMsg(err)}) — falling back to interactive consent`);
    }
  }
  const tokens = await interactiveConsent(url, auth, Date.now());
  writeTokenCache(file, tokens);
  log("oauth2 consent complete — token cached");
  return tokens;
}
/** Refresh an access token and persist the result. Throws if no refresh token. */
export async function refreshOAuthToken(url, auth, current) {
  if (!current.refreshToken) throw new Error("no refresh token available");
  const refreshed = await refresh(url, auth, current.refreshToken, Date.now());
  // Mattermost may not rotate the refresh token — keep the previous one if absent.
  const merged = {
    ...refreshed,
    refreshToken: refreshed.refreshToken ?? current.refreshToken,
  };
  writeTokenCache(tokenCacheFile(url, auth.clientId), merged);
  return merged;
}
function errMsg(err) {
  return err instanceof Error ? err.message : String(err);
}
