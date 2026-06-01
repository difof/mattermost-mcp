// Persisted login state written by `mattermost-mcp login` and read by the
// server at startup. Only `pat` and `oauth2` are ever stored: a password login
// is exchanged for a session token up front and saved as a `pat`, so no
// plaintext password ever touches disk. The file is 0600 (token / client secret).
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { credentialsFile } from "./paths.js";
import { loadConfig, type Config } from "./config.js";

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
  url: z.string().url(),
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
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
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
 * are the baseline, and the real process env overrides them key-by-key (so
 * explicit `MM_*` vars — e.g. in CI — always win). Throws like {@link loadConfig}
 * when neither source yields a complete, valid configuration.
 */
export function resolveConfig(env: Record<string, string | undefined> = process.env): Config {
  const stored = readCredentials();
  const base = stored ? credentialsToEnv(stored) : {};
  return loadConfig({ ...base, ...env });
}
