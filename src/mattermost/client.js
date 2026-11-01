// @mattermost/client exposes CommonJS getters that Node cannot detect as named
// exports. Import its default namespace for Client4 and ClientError.
import mattermost from "@mattermost/client";
import { acquireOAuthToken, refreshOAuthToken } from "./oauth.js";
import { formatMattermostError } from "./errors.js";
import { applyRequestTimeout, applyRequestResilience } from "./resilience.js";
import { DEFAULT_RESILIENCE } from "../config.js";
import { log } from "../log.js";
import { VERSION } from "../version.js";
const USER_AGENT = `mattermost-mcp/${VERSION}`;
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
// Bind both initial authentication and 401 recovery to the same credential state.
function sessionAuthentication(client, { auth, url }, timeoutMs) {
  if (auth.mode === "pat") return { authenticate: () => client.setToken(auth.token) };
  if (auth.mode === "password") {
    const login = () => client.login(auth.loginId, auth.password, auth.mfaToken ?? "");
    return {
      authenticate: login,
      async recover() {
        log("session token expired (401) — re-authenticating");
        await login();
        return true;
      },
    };
  }

  if (auth.mode !== "oauth2") throw new Error("Unsupported Mattermost authentication mode");
  let tokens;
  function applyTokens(next) {
    tokens = next;
    client.setToken(tokens.accessToken);
  }
  return {
    async authenticate() {
      applyTokens(await acquireOAuthToken(url, auth, timeoutMs));
    },
    async recover() {
      if (!tokens?.refreshToken) return false;
      log("access token expired (401) — refreshing");
      applyTokens(await refreshOAuthToken(url, auth, tokens, timeoutMs));
      return true;
    },
  };
}

// Concurrent 401s share one login/refresh. Rotating tokens must not be redeemed twice.
function sharedRecovery(recover) {
  if (!recover) return undefined;
  let pending;
  return () =>
    (pending ??= recover().finally(() => {
      pending = undefined;
    }));
}

/** Authenticate and verify the account with GET /users/me before accepting requests. */
export async function createSession(config, { verify = (client) => client.getMe() } = {}) {
  const { auth, url } = config;
  const resilience = config.resilience ?? DEFAULT_RESILIENCE;
  const client = buildClient(url, resilience.timeoutMs);
  const { authenticate, recover } = sessionAuthentication(client, config, resilience.timeoutMs);
  // Cached OAuth access tokens can be revoked before their recorded expiry.
  // Apply the same recovery policy to startup verification and later requests.
  applyRequestResilience(client, resilience, sharedRecovery(recover));
  // Fail fast with an actionable message instead of a raw API error dump.
  let me;
  try {
    await authenticate();
    me = await verify(client);
  } catch (err) {
    throw new Error(
      `Mattermost authentication failed (mode=${auth.mode}): ${formatMattermostError(err)}. ` +
        `Verify your MM_* credentials and that ${url} is reachable.`,
    );
  }
  log(`authenticated as @${me.username} (${me.id}) via ${auth.mode}`);
  return {
    client,
    config,
    userId: me.id,
    // Never replay a callback: it may have already completed a successful write
    // before a later request fails. Retry/auth recovery live in the transport.
    call: async (fn) => fn(client),
  };
}
