import { z } from "zod";
import type { ResilienceConfig } from "./mattermost/resilience.js";

// --- Public config shape -----------------------------------------------------

export type AuthConfig =
  | { mode: "pat"; token: string }
  | { mode: "password"; loginId: string; password: string; mfaToken?: string }
  | { mode: "oauth2"; clientId: string; clientSecret: string; redirect: string };

export interface GuardrailConfig {
  readOnly: boolean;
  allowDestructive: boolean;
  teamAllowlist: string[]; // empty = no restriction
  channelAllowlist: string[]; // empty = no restriction
  maxMessageLen: number;
}

export interface Config {
  url: string; // server root, no trailing slash, no /api/v4
  auth: AuthConfig;
  guardrails: GuardrailConfig;
  // Optional so test fixtures can omit it; loadConfig always populates it and
  // createSession falls back to DEFAULT_RESILIENCE when absent.
  resilience?: ResilienceConfig;
}

// --- Env schema --------------------------------------------------------------

const boolEnv = (def: "true" | "false") =>
  z
    .preprocess((v) => (v == null ? def : v), z.enum(["true", "false"]))
    .transform((v) => v === "true");

/** Mattermost's server root, optionally including a deployment subpath. */
export const ServerUrlSchema = z
  .string()
  .trim()
  .url()
  .superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return; // The URL validator already reports malformed URLs.
    }
    const issue = (message: string): void => {
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
    const require = (key: keyof typeof e, present: unknown) => {
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

type Env = z.infer<typeof EnvSchema>;

// --- Mapping -----------------------------------------------------------------

function csvToList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildAuth(e: Env): AuthConfig {
  switch (e.MM_AUTH_MODE) {
    case "pat":
      return { mode: "pat", token: e.MM_TOKEN! };
    case "password":
      return {
        mode: "password",
        loginId: e.MM_LOGIN_ID!,
        password: e.MM_PASSWORD!,
        ...(e.MM_MFA_TOKEN ? { mfaToken: e.MM_MFA_TOKEN } : {}),
      };
    case "oauth2":
      return {
        mode: "oauth2",
        clientId: e.MM_CLIENT_ID!,
        clientSecret: e.MM_CLIENT_SECRET!,
        redirect: e.MM_OAUTH_REDIRECT,
      };
  }
}

/**
 * Parse and validate environment into a typed {@link Config}.
 * Throws with a readable, multi-line message on invalid config (fail fast).
 * Empty-string env values are treated as unset.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
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
