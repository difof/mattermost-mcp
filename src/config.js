import { z } from "zod";
// --- Env schema --------------------------------------------------------------
const boolEnv = (def) =>
  z
    .preprocess((v) => (v == null ? def : v), z.enum(["true", "false"]))
    .transform((v) => v === "true");
/** Mattermost's server root, optionally including a deployment subpath. */
export const ServerUrlSchema = z
  .string()
  .trim()
  .url()
  .superRefine((value, ctx) => {
    let url;
    try {
      url = new URL(value);
    } catch {
      return; // The URL validator already reports malformed URLs.
    }
    const issue = (message) => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    };
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      issue("Use an http:// or https:// Mattermost server URL");
    }
    if (url.username || url.password || value.includes("?") || value.includes("#")) {
      issue("The Mattermost server URL must not include credentials, a query, or a fragment");
    }
    if (/\/api\/v4\/*$/.test(url.pathname)) {
      issue("Use the Mattermost server root URL without /api/v4");
    }
  })
  .transform((value) => new URL(value).toString().replace(/\/+$/, ""));
const EnvSchema = z
  .object({
    MM_URL: ServerUrlSchema,
    MM_AUTH_MODE: z.enum(["pat", "password", "oauth2"]).default("pat"),
    MM_TOKEN: z.string().min(1).optional(),
    MM_LOGIN_ID: z.string().min(1).optional(),
    MM_PASSWORD: z.string().min(1).optional(),
    MM_MFA_TOKEN: z.string().min(1).optional(),
    MM_CLIENT_ID: z.string().min(1).optional(),
    MM_CLIENT_SECRET: z.string().min(1).optional(),
    MM_OAUTH_REDIRECT: z.string().url().default("http://127.0.0.1:7000/callback"),
    MM_READ_ONLY: boolEnv("false"),
    MM_ALLOW_DESTRUCTIVE: boolEnv("false"),
    MM_TEAM_ALLOWLIST: z.string().optional(),
    MM_CHANNEL_ALLOWLIST: z.string().optional(),
    MM_MAX_MESSAGE_LEN: z.coerce.number().int().positive().default(16383),
    MM_REQUEST_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(30000),
    MM_MAX_RETRIES: z.coerce.number().int().nonnegative().default(3),
    MM_RETRY_BASE_MS: z.coerce.number().int().positive().default(500),
  })
  .superRefine((e, ctx) => {
    const require = (key, present) => {
      if (!present) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required when MM_AUTH_MODE=${e.MM_AUTH_MODE}`,
        });
      }
    };
    if (e.MM_AUTH_MODE === "pat") {
      require("MM_TOKEN", e.MM_TOKEN);
    } else if (e.MM_AUTH_MODE === "password") {
      require("MM_LOGIN_ID", e.MM_LOGIN_ID);
      require("MM_PASSWORD", e.MM_PASSWORD);
    } else {
      require("MM_CLIENT_ID", e.MM_CLIENT_ID);
      require("MM_CLIENT_SECRET", e.MM_CLIENT_SECRET);
    }
  });
// --- Mapping -----------------------------------------------------------------
function csvToList(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
function buildAuth(e) {
  switch (e.MM_AUTH_MODE) {
    case "pat":
      return { mode: "pat", token: e.MM_TOKEN };
    case "password":
      return {
        mode: "password",
        loginId: e.MM_LOGIN_ID,
        password: e.MM_PASSWORD,
        ...(e.MM_MFA_TOKEN ? { mfaToken: e.MM_MFA_TOKEN } : {}),
      };
    case "oauth2":
      return {
        mode: "oauth2",
        clientId: e.MM_CLIENT_ID,
        clientSecret: e.MM_CLIENT_SECRET,
        redirect: e.MM_OAUTH_REDIRECT,
      };
  }
}
/**
 * Parse and validate environment into the server configuration.
 * Throws with a readable, multi-line message on invalid config (fail fast).
 * Empty-string env values are treated as unset.
 */
export function loadConfig(env = process.env) {
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ""),
  );
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    throw new Error(`Invalid mattermost-mcp configuration:\n${lines.join("\n")}`);
  }
  const e = parsed.data;
  return {
    url: e.MM_URL,
    auth: buildAuth(e),
    guardrails: {
      readOnly: e.MM_READ_ONLY,
      allowDestructive: e.MM_ALLOW_DESTRUCTIVE,
      teamAllowlist: csvToList(e.MM_TEAM_ALLOWLIST),
      channelAllowlist: csvToList(e.MM_CHANNEL_ALLOWLIST),
      maxMessageLen: e.MM_MAX_MESSAGE_LEN,
    },
    resilience: {
      timeoutMs: e.MM_REQUEST_TIMEOUT_MS,
      maxRetries: e.MM_MAX_RETRIES,
      baseDelayMs: e.MM_RETRY_BASE_MS,
    },
  };
}
