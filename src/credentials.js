// Persisted login state written by `mattermost-mcp login` and read by the
// server at startup. Only `pat` and `oauth2` are ever stored: a password login
// is exchanged for a session token up front and saved as a `pat`, so no
// plaintext password ever touches disk. The file is 0600 (token / client secret).
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { credentialsFile } from "./paths.js";
import { loadConfig, ServerUrlSchema } from "./config.js";
const StoredAuthSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("pat"), token: z.string().min(1) }),
  z.object({
    mode: z.literal("oauth2"),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    redirect: z.string().url(),
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
  const validated = StoredCredentialsSchema.parse(creds);
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Replacing the file atomically preserves the previous login on a failed
  // write, fixes existing permissive modes, and never follows a destination symlink.
  const temporaryDir = mkdtempSync(join(dir, ".credentials-"));
  try {
    const temporaryFile = join(temporaryDir, "credentials.json");
    writeFileSync(temporaryFile, JSON.stringify(validated, null, 2) + "\n", { mode: 0o600 });
    renameSync(temporaryFile, file);
  } finally {
    rmSync(temporaryDir, { recursive: true, force: true });
  }
}
/** Delete the credentials file. Returns `true` if a file was removed. */
export function clearCredentials(file = credentialsFile()) {
  try {
    rmSync(file);
    return true;
  } catch {
    return false;
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
