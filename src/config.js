import { z } from "zod";
import { isAbsolute } from "node:path";
export const DEFAULT_OAUTH_REDIRECT = "http://127.0.0.1:7000/callback";
export const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const DEFAULT_RESILIENCE = {
  timeoutMs: 30_000,
  maxRetries: 3,
  baseDelayMs: 500,
};
// --- Env schema --------------------------------------------------------------
const boolEnv = (def) =>
  z
    .preprocess((v) => (v == null ? def : v), z.enum(["true", "false"]))
    .transform((v) => v === "true");
const uploadRoots = z
  .string()
  .default("[]")
  .transform((value, ctx) => {
    try {
      const roots = JSON.parse(value);
      if (
        !Array.isArray(roots) ||
        roots.some((root) => typeof root !== "string" || !isAbsolute(root) || root.includes("\0"))
      ) {
        throw new Error();
      }
      return [...new Set(roots)];
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Use a JSON array of absolute upload directory paths",
      });
      return z.NEVER;
    }
  });
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
/** The consent catcher serves HTTP on the loopback host named in this URI. */
export const OAuthRedirectSchema = z
  .string()
  .trim()
  .url()
  .superRefine((value, ctx) => {
    let url;
    try {
      url = new URL(value);
    } catch {
      return;
    }
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
      url.username ||
      url.password ||
      value.includes("?") ||
      value.includes("#") ||
      url.port === "0"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Use an HTTP loopback OAuth redirect (127.0.0.1, [::1], or localhost) with a nonzero port and no credentials, query, or fragment",
      });
    }
  });
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
    MM_OAUTH_REDIRECT: OAuthRedirectSchema.default(DEFAULT_OAUTH_REDIRECT),
    MM_READ_ONLY: boolEnv("false"),
    MM_ALLOW_DESTRUCTIVE: boolEnv("false"),
    MM_TEAM_ALLOWLIST: z.string().optional(),
    MM_CHANNEL_ALLOWLIST: z.string().optional(),
    MM_MAX_MESSAGE_LEN: z.coerce.number().int().positive().default(16383),
    MM_UPLOAD_ROOTS: uploadRoots,
    MM_MAX_UPLOAD_BYTES: z.coerce
      .number()
      .int()
      .safe()
      .positive()
      .default(DEFAULT_MAX_UPLOAD_BYTES),
    MM_REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(DEFAULT_RESILIENCE.timeoutMs),
    MM_MAX_RETRIES: z.coerce.number().int().nonnegative().default(DEFAULT_RESILIENCE.maxRetries),
    MM_RETRY_BASE_MS: z.coerce.number().int().positive().default(DEFAULT_RESILIENCE.baseDelayMs),
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
    uploads: {
      roots: e.MM_UPLOAD_ROOTS,
      maxBytes: e.MM_MAX_UPLOAD_BYTES,
    },
    resilience: {
      timeoutMs: e.MM_REQUEST_TIMEOUT_MS,
      maxRetries: e.MM_MAX_RETRIES,
      baseDelayMs: e.MM_RETRY_BASE_MS,
    },
  };
}
