// `mattermost-mcp logout` — remove saved credentials (and the matching OAuth
// token cache, if any). Env-based config is unaffected.
import { rmSync } from "node:fs";
import { readCredentials, clearCredentials } from "../credentials.js";
import { credentialsFile } from "../paths.js";
import { tokenCacheFile } from "../mattermost/oauth.js";

export function runLogout(): void {
  const creds = readCredentials();
  const removed = clearCredentials();

  // Drop the cached OAuth access/refresh tokens for this server too.
  if (creds?.auth.mode === "oauth2") {
    try {
      rmSync(tokenCacheFile(creds.url, creds.auth.clientId));
    } catch {
      // no cache to remove — fine
    }
  }

  process.stdout.write(
    removed
      ? `✓ Logged out — removed ${credentialsFile()}\n`
      : "Not logged in (no saved credentials).\n",
  );
}
