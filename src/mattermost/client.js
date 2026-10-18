// @mattermost/client exposes CommonJS getters that Node cannot detect as named
// exports. Import its default namespace for Client4 and ClientError.
import mattermost from "@mattermost/client";
import { acquireOAuthToken, refreshOAuthToken } from "./oauth.js";
import { formatMattermostError } from "./errors.js";
import { applyRequestTimeout, applyRequestResilience, DEFAULT_RESILIENCE } from "./resilience.js";
import { log } from "../log.js";
const USER_AGENT = "mattermost-mcp/0.1.0";
/** Construct a headless Client4 (Bearer-only, cookies off, per-request timeout). */
export function buildClient(url, timeoutMs) {
  const client = new mattermost.Client4();
  client.setUrl(url);
  client.setUserAgent(USER_AGENT);
  // Headless: authenticate via Bearer header only. Disable cookie credentials
  // (webapp CSRF is cookie/document-based and irrelevant outside a browser).
  client.setIncludeCookies(false);
  // Abort any request that exceeds the configured timeout.
  applyRequestTimeout(client, timeoutMs);
  return client;
}
/** Use the SDK transport for verified API routes without a named Client4 method. */
export function doClientFetch(client, url, options) {
  // Keep access to Client4's internal transport at the session boundary.
  return client.doFetch(url, options);
}
/**
 * Authenticate against Mattermost and return a ready session.
 * Verifies credentials with a `GET /users/me` smoke call (also our identity).
 * Throws (fails fast) on auth or connectivity errors.
 */
export async function createSession(config) {
  const { auth, url } = config;
  const resilience = config.resilience ?? DEFAULT_RESILIENCE;
  const client = buildClient(url, resilience.timeoutMs);
  // oauth2 keeps mutable token state so a 401 can transparently refresh.
  let oauthTokens = null;
  async function authenticate() {
    switch (auth.mode) {
      case "pat":
        // PAT → Bearer header on every request. No network call here.
        client.setToken(auth.token);
        return;
      case "password":
        // POST /users/login; login() captures the session token from the
        // `Token` response header and calls setToken() internally.
        await client.login(auth.loginId, auth.password, auth.mfaToken ?? "");
        return;
      case "oauth2": {
        // Cache-first; runs interactive consent only when no usable token exists.
        oauthTokens = await acquireOAuthToken(url, auth);
        client.setToken(oauthTokens.accessToken);
        return;
      }
    }
  }
  // Recover from a 401 in-flight: re-login (password) or refresh (oauth2).
  async function recover() {
    if (auth.mode === "password") {
      log("session token expired (401) — re-authenticating");
      await client.login(auth.loginId, auth.password, auth.mfaToken ?? "");
      return true;
    }
    if (auth.mode === "oauth2" && oauthTokens?.refreshToken) {
      log("access token expired (401) — refreshing");
      oauthTokens = await refreshOAuthToken(url, auth, oauthTokens);
      client.setToken(oauthTokens.accessToken);
      return true;
    }
    return false;
  }
  // Concurrent requests can encounter the same expired token. Share one login
  // or refresh so rotating refresh tokens are not redeemed more than once.
  let recovery;
  const recoverAuthentication = () => {
    if (!recovery) {
      recovery = recover().finally(() => {
        recovery = undefined;
      });
    }
    return recovery;
  };
  // Fail fast with an actionable message instead of a raw API error dump.
  let me;
  try {
    await authenticate();
    me = await client.getMe();
  } catch (err) {
    throw new Error(
      `Mattermost authentication failed (mode=${auth.mode}): ${formatMattermostError(err)}. ` +
        `Verify your MM_* credentials and that ${url} is reachable.`,
    );
  }
  log(`authenticated as @${me.username} (${me.id}) via ${auth.mode}`);
  applyRequestResilience(client, resilience, recoverAuthentication);
  return {
    client,
    config,
    userId: me.id,
    // Never replay a callback: it may have already completed a successful write
    // before a later request fails. Retry/auth recovery live in the transport.
    call: async (fn) => fn(client),
  };
}
