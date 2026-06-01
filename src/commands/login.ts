// `mattermost-mcp login` — interactive auth wizard. Validates the credentials
// against the server (GET /users/me) before saving them 0600 to the config dir.
import type { Client4 } from "@mattermost/client";
import { buildClient } from "../mattermost/client.js";
import { acquireOAuthToken } from "../mattermost/oauth.js";
import { DEFAULT_RESILIENCE } from "../mattermost/resilience.js";
import { formatMattermostError } from "../mattermost/errors.js";
import { writeCredentials, type StoredCredentials } from "../credentials.js";
import { credentialsFile } from "../paths.js";
import { prompt, promptSecret } from "../prompt.js";

type Mode = "pat" | "password" | "oauth2";

const DEFAULT_REDIRECT = "http://127.0.0.1:7000/callback";

/** Trim trailing slashes and a stray `/api/v4`, then validate the URL. */
function normalizeUrl(raw: string): string {
  const trimmed = raw
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/api\/v4$/, "");
  new URL(trimmed); // throws on a malformed URL; caught by the caller
  return trimmed;
}

async function promptUrl(): Promise<string> {
  for (;;) {
    const raw = await prompt("Mattermost server URL (e.g. https://mm.example.com): ");
    try {
      return normalizeUrl(raw);
    } catch {
      process.stderr.write("  Invalid URL — include the scheme, e.g. https://mm.example.com\n");
    }
  }
}

async function promptMode(): Promise<Mode> {
  process.stderr.write(
    "Authentication mode:\n" +
      "  1) pat       paste a Personal Access Token\n" +
      "  2) password  username/email + password (+ MFA)\n" +
      "  3) oauth2    OAuth2 app + browser consent\n",
  );
  for (;;) {
    const choice = (await prompt("Choice [1]: ")) || "1";
    if (choice === "1" || choice.toLowerCase() === "pat") return "pat";
    if (choice === "2" || choice.toLowerCase() === "password") return "password";
    if (choice === "3" || choice.toLowerCase() === "oauth2") return "oauth2";
    process.stderr.write("  Enter 1, 2, or 3.\n");
  }
}

/** Confirm a Bearer-authenticated client works, returning the identity. */
async function verify(client: Client4, url: string): Promise<{ username: string }> {
  try {
    const me = await client.getMe();
    return { username: me.username };
  } catch (err) {
    throw new Error(`Authentication failed against ${url}: ${formatMattermostError(err)}`);
  }
}

export async function runLogin(): Promise<void> {
  const url = await promptUrl();
  const mode = await promptMode();
  const client = buildClient(url, DEFAULT_RESILIENCE.timeoutMs);

  let stored: StoredCredentials;
  let username: string;

  if (mode === "pat") {
    const token = await promptSecret("Personal Access Token: ");
    client.setToken(token);
    ({ username } = await verify(client, url));
    stored = { url, auth: { mode: "pat", token } };
  } else if (mode === "password") {
    const loginId = await prompt("Login ID (username or email): ");
    const password = await promptSecret("Password: ");
    const mfaToken = await prompt("MFA token (leave blank if none): ");
    try {
      const me = await client.login(loginId, password, mfaToken);
      username = me.username;
    } catch (err) {
      throw new Error(`Login failed against ${url}: ${formatMattermostError(err)}`);
    }
    // Exchange the password for the session token captured by login(), and save
    // that as a pat — the password itself is never written to disk.
    const token = client.getToken();
    if (!token) throw new Error("Login succeeded but the server returned no session token.");
    stored = { url, auth: { mode: "pat", token } };
  } else {
    const clientId = await prompt("OAuth2 Client ID: ");
    const clientSecret = await promptSecret("OAuth2 Client Secret: ");
    const redirect = (await prompt(`Redirect URI [${DEFAULT_REDIRECT}]: `)) || DEFAULT_REDIRECT;
    const auth = { mode: "oauth2", clientId, clientSecret, redirect } as const;
    // Runs the browser consent flow and caches the OAuth tokens under the config dir.
    const tokens = await acquireOAuthToken(url, auth);
    client.setToken(tokens.accessToken);
    ({ username } = await verify(client, url));
    stored = { url, auth };
  }

  writeCredentials(stored);
  process.stdout.write(
    `✓ Logged in as @${username} on ${url}\n` +
      `  Saved to ${credentialsFile()} (mode: ${stored.auth.mode}, 0600)\n` +
      `  The MCP server will use these automatically. MM_* env vars override them.\n`,
  );
}
