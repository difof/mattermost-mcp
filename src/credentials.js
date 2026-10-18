// Persisted login state written by `mattermost-mcp login` and read by the
// server at startup. Only `pat` and `oauth2` are ever stored: a password login
// is exchanged for a session token up front and saved as a `pat`, so no
// plaintext password ever touches disk. The file is 0600 (token / client secret).
import { readFileSync, rmSync } from "node:fs";
import { z } from "zod";
import { credentialsFile } from "./paths.js";
import { loadConfig, ServerUrlSchema, OAuthRedirectSchema } from "./config.js";
import { writePrivateJson } from "./private-json.js";
const StoredAuthSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("pat"), token: z.string().min(1) }),
  z.object({
    mode: z.literal("oauth2"),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    redirect: OAuthRedirectSchema,
  }),
]);
export const StoredCredentialsSchema = z.object({
  url: ServerUrlSchema,
  auth: StoredAuthSchema,
});
/** Read saved credentials, or `null` if absent/corrupt (treated as logged out). */
export function readCredentials(file = credentialsFile()) {
  try {
    return StoredCredentialsSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}
/** Persist credentials with `0600` permissions, creating the config dir if needed. */
export function writeCredentials(creds, file = credentialsFile()) {
  writePrivateJson(file, StoredCredentialsSchema.parse(creds));
}
/** Delete the credentials file. Returns `true` if a file was removed. */
export function clearCredentials(file = credentialsFile()) {
  try {
    rmSync(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
/** Map stored credentials onto the `MM_*` env vars loadConfig understands. */
export function credentialsToEnv(creds) {
  const env = {
    MM_URL: creds.url,
    MM_AUTH_MODE: creds.auth.mode,
  };
  if (creds.auth.mode === "pat") {
    env.MM_TOKEN = creds.auth.token;
  } else {
    env.MM_CLIENT_ID = creds.auth.clientId;
    env.MM_CLIENT_SECRET = creds.auth.clientSecret;
    env.MM_OAUTH_REDIRECT = creds.auth.redirect;
  }
  return env;
}
/**
 * Resolve the effective server configuration: saved login credentials
 * are the baseline for the same server, and non-empty process env values
 * override them key-by-key. Changing MM_URL requires credentials for that
 * server: never send saved tokens or client secrets to a different destination.
 * Throws like loadConfig when neither source yields a valid configuration.
 */
export function resolveConfig(env = process.env) {
  const stored = readCredentials();
  const explicit = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ""),
  );
  const target = explicit.MM_URL ? ServerUrlSchema.safeParse(explicit.MM_URL) : null;
  const useStored = stored && (!target || (target.success && target.data === stored.url));
  const base = useStored ? credentialsToEnv(stored) : {};
  return loadConfig({ ...base, ...explicit });
}
