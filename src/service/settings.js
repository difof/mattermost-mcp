import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { writePrivateJson } from "../private-json.js";

const positive = z.number().int().safe().positive();
const nonnegative = z.number().int().safe().nonnegative();
const maxTimerMs = 2 ** 31 - 1;

// One allowlist defines the input types, help text and application mode. No secrets,
// arbitrary environment names, origins, file paths or callback destinations belong here.
const fields = {
  retention_hours: [
    positive.max(168),
    "Cache post bodies for this many hours from creation (1–168). Shortening retention removes expired content.",
  ],
  read_only: [z.boolean(), "Block Mattermost writes and subscription changes while enabled."],
  allow_destructive: [
    z.boolean(),
    "Permit destructive tools only with their separate per-call confirmation.",
  ],
  max_message_len: [positive, "Maximum number of characters in an outgoing message."],
  max_upload_bytes: [positive, "Maximum aggregate file/binary bytes per upload."],
  http_max_body_bytes: [
    positive.max(256 * 1024 * 1024),
    "Maximum ordinary MCP (/mcp) request body bytes; applies to the next request.",
  ],
  request_timeout_ms: [
    nonnegative.max(maxTimerMs),
    "Mattermost request timeout in milliseconds; zero disables the configured timeout.",
  ],
  max_retries: [nonnegative.max(10), "Maximum retry count for safe Mattermost requests (0–10)."],
  retry_base_ms: [positive.max(60000), "Initial retry delay in milliseconds (1–60000)."],
  events_enabled: [z.boolean(), "Enable the message cache, listener and opt-in subscriptions."],
  http_port: [
    positive.max(65535),
    "IPv4 loopback listener port. Restart the service and update client URLs to change it.",
    "restart",
  ],
};

export const SETTING_INFO = Object.fromEntries(
  Object.entries(fields).map(([key, [, description, apply = "live"]]) => [
    key,
    { apply, description },
  ]),
);
const shape = Object.fromEntries(Object.entries(fields).map(([key, [type]]) => [key, type]));
const completeSchema = z.object(shape).strict("Unsupported setting name");
const overrideSchema = completeSchema.partial().strict("Unsupported setting name");
export const settingsPatchSchema = z
  .object(
    Object.fromEntries(
      Object.entries(shape).map(([key, type]) => [key, type.nullable().optional()]),
    ),
  )
  .strict("Unsupported setting name")
  .refine(
    (patch) => Object.values(patch).some((value) => value !== undefined),
    "Provide at least one setting",
  );

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function validated(schema, value, label) {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  // Unknown keys and submitted literals must not be reflected by admin MCP errors.
  const key = result.error.issues[0]?.path[0];
  throw failure(
    "INVALID_SETTINGS",
    "Invalid " + label + (Object.hasOwn(fields, key) ? ": " + key : ""),
  );
}

export function settingsFile(env = process.env) {
  const file =
    env.MM_SETTINGS_FILE ||
    join(
      env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
      "mattermost-mcp",
      "settings.json",
    );
  if (!isAbsolute(file) || file.includes("\0"))
    throw failure("INVALID_SETTINGS", "Use an absolute MM_SETTINGS_FILE or XDG_STATE_HOME");
  return file;
}

export function bootstrapSettings(config, http, env = process.env) {
  const hours = env.MM_RETENTION_HOURS || "48";
  return validated(
    completeSchema,
    {
      retention_hours: /^\d+$/.test(hours) ? Number(hours) : NaN,
      read_only: config.guardrails.readOnly,
      allow_destructive: config.guardrails.allowDestructive,
      max_message_len: config.guardrails.maxMessageLen,
      max_upload_bytes: config.uploads.maxBytes,
      http_max_body_bytes: http.maxBodyBytes,
      request_timeout_ms: config.resilience.timeoutMs,
      max_retries: config.resilience.maxRetries,
      retry_base_ms: config.resilience.baseDelayMs,
      events_enabled: http.eventsEnabled,
      http_port: http.port,
    },
    "bootstrap setting",
  );
}

export function patchOverrides(overrides, patch) {
  const next = { ...validated(overrideSchema, overrides, "stored settings") };
  for (const [key, value] of Object.entries(
    validated(settingsPatchSchema, patch, "settings patch"),
  )) {
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  }
  return next;
}
export function effectiveSettings(defaults, overrides) {
  return validated(
    completeSchema,
    { ...defaults, ...validated(overrideSchema, overrides, "stored settings") },
    "effective settings",
  );
}

function snapshot(input) {
  const values = validated(overrideSchema, input, "stored settings");
  const overrides = Object.fromEntries(
    Object.keys(values)
      .sort()
      .map((key) => [key, values[key]]),
  );
  return {
    overrides,
    revision: createHash("sha256").update(JSON.stringify(overrides)).digest("hex"),
  };
}

export function readOverrides(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW || 0));
  } catch (error) {
    if (error.code === "ENOENT") return snapshot({});
    throw failure("INVALID_SETTINGS", "Cannot open the managed settings file");
  }
  try {
    const st = fstatSync(fd);
    if (
      !st.isFile() ||
      st.nlink !== 1 ||
      st.size > 16384 ||
      (process.platform !== "win32" && (st.uid !== process.getuid() || (st.mode & 0o077) !== 0))
    ) {
      throw failure("INVALID_SETTINGS", "Use an owner-only regular settings file (maximum 16 KiB)");
    }
    let value;
    try {
      value = JSON.parse(readFileSync(fd, "utf8"));
    } catch {
      throw failure("INVALID_SETTINGS", "Invalid settings file JSON");
    }
    return snapshot(value);
  } finally {
    closeSync(fd);
  }
}

export function writeOverrides(file, overrides, expectedRevision) {
  const next = snapshot(overrides);
  // No await between re-reading the disk revision and atomic replacement. The
  // service serializes writers and rechecks after any async candidate validation.
  const previous = readOverrides(file);
  if (expectedRevision !== previous.revision) {
    throw failure("REVISION_CONFLICT", "Settings changed since they were loaded; reload and retry");
  }
  if (next.revision !== previous.revision) {
    try {
      writePrivateJson(file, next.overrides);
    } catch {
      throw failure("SAVE_FAILED", "Could not persist managed settings");
    }
  }
  return next;
}
