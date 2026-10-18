// Persisted login state written by `mattermost-mcp login` and read by the
// server at startup. Only `pat` and `oauth2` are ever stored: a password login
// is exchanged for a session token up front and saved as a `pat`, so no
// plaintext password ever touches disk. The file is 0600 (token / client secret).
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { credentialsFile } from "./paths.js";
import { loadConfig, ServerUrlSchema, type Config } from "./config.js";

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

export type StoredCredentials = z.infer<typeof StoredCredentialsSchema>;

/** Read saved credentials, or `null` if absent/corrupt (treated as logged out). */
export function readCredentials(file: string = credentialsFile()): StoredCredentials | null {
  try {
    return StoredCredentialsSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

/** Persist credentials with `0600` permissions, creating the config dir if needed. */
export function writeCredentials(creds: StoredCredentials, file: string = credentialsFile()): void {
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
export function clearCredentials(file: string = credentialsFile()): boolean {
  try {
    rmSync(file);
    return true;
  } catch {
    return false;
  }
}

/** Map stored credentials onto the `MM_*` env vars {@link loadConfig} understands. */
export function credentialsToEnv(creds: StoredCredentials): Record<string, string> {
  const env: Record<string, string> = {
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
 * Resolve the effective {@link Config} for the server: saved login credentials
 * are the baseline for the same server, and non-empty process env values
 * override them key-by-key. Changing MM_URL requires credentials for that
 * server: never send saved tokens or client secrets to a different destination.
 * Throws like {@link loadConfig} when neither source yields a valid config.
 */
export function resolveConfig(env: Record<string, string | undefined> = process.env): Config {
  const stored = readCredentials();
  const explicit = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ""),
  );
  const target = explicit.MM_URL ? ServerUrlSchema.safeParse(explicit.MM_URL) : null;
  const useStored = stored && (!target || (target.success && target.data === stored.url));
  const base = useStored ? credentialsToEnv(stored) : {};
  return loadConfig({ ...base, ...explicit });
}
