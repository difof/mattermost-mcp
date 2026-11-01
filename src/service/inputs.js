import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { homedir } from "node:os";
import { resolveConfig } from "../credentials.js";
import { httpSettings } from "../http/config.js";
import { callbackTargets } from "../events/callbacks.js";
import { readSecretFile } from "./secret.js";
import { bootstrapSettings } from "./settings.js";

export function serviceError(code) {
  return Object.assign(new Error(code), { code });
}

function patFromFile(env) {
  if (
    !isAbsolute(env.MM_TOKEN_FILE) ||
    !env.MM_URL ||
    (env.MM_AUTH_MODE && env.MM_AUTH_MODE !== "pat")
  )
    throw serviceError("INVALID_SETTINGS");
  const contents = readSecretFile(env.MM_TOKEN_FILE);
  let token = contents;
  if (env.MM_TOKEN_FILE_LINE !== undefined) {
    if (!/^[1-9]\d*$/.test(env.MM_TOKEN_FILE_LINE)) throw serviceError("INVALID_SETTINGS");
    token = contents.split(/\r?\n/)[Number(env.MM_TOKEN_FILE_LINE) - 1]?.trim();
  }
  if (!token || /\s/u.test(token) || token.includes("\0"))
    throw serviceError("INVALID_CREDENTIALS");
  return token;
}

function validateSecrets(config, http, env) {
  const { token, adminToken } = http;
  const credentials = [token, adminToken, config.auth.token].filter(Boolean);
  if (new Set(credentials).size !== credentials.length) throw serviceError("INVALID_CREDENTIALS");
  // Ordinary MCP clients can upload files from these roots; the admin credential must not be there.
  if (env.MM_ADMIN_TOKEN_FILE) {
    const file = realpathSync(env.MM_ADMIN_TOKEN_FILE);
    for (const root of config.uploads.roots) {
      let canonical;
      try {
        canonical = realpathSync(root);
      } catch (e) {
        if (e.code === "ENOENT") continue;
        throw e;
      }
      const r = relative(canonical, file);
      if (r === "" || (r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r)))
        throw serviceError("INVALID_SETTINGS");
    }
  }
}

function loadInputs(env) {
  const vars = env.MM_TOKEN_FILE ? { ...env, MM_TOKEN: patFromFile(env) } : env;
  if (env.MM_TOKEN_FILE_LINE && !env.MM_TOKEN_FILE) throw serviceError("INVALID_SETTINGS");
  const config = resolveConfig(vars),
    http = httpSettings(env);
  validateSecrets(config, http, env);
  return {
    config,
    stateDir:
      env.MM_EVENTS_STATE_DIR ||
      join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "mattermost-mcp"),
    http,
    defaults: bootstrapSettings(config, http, env),
    targets: callbackTargets(env),
  };
}

export function readInputs(env) {
  try {
    return loadInputs(env);
  } catch (error) {
    if (error.code === "INVALID_SETTINGS" || error.code === "INVALID_CREDENTIALS") throw error;
    // Parse errors can quote part of a malformed secret-bearing file.
    throw serviceError("INVALID_CREDENTIALS");
  }
}

export function sessionConfig(base, v) {
  return {
    ...base,
    guardrails: {
      ...base.guardrails,
      readOnly: v.read_only,
      allowDestructive: v.allow_destructive,
      maxMessageLen: v.max_message_len,
    },
    uploads: { ...base.uploads, maxBytes: v.max_upload_bytes },
    resilience: {
      timeoutMs: v.request_timeout_ms,
      maxRetries: v.max_retries,
      baseDelayMs: v.retry_base_ms,
    },
  };
}

export function secretStatus(env, config) {
  const slot = (configured, source) => ({
    configured: Boolean(configured),
    source: configured ? source : null,
    reloadable: Boolean(configured) && source !== "environment",
  });
  return {
    mattermost: slot(
      config.auth.mode,
      env.MM_TOKEN_FILE
        ? "private_file"
        : env.MM_TOKEN || env.MM_PASSWORD || env.MM_CLIENT_SECRET
          ? "environment"
          : "saved_login",
    ),
    http_bearer: slot(true, env.MM_HTTP_TOKEN_FILE ? "private_file" : "environment"),
    admin_bearer: slot(env.MM_ADMIN_TOKEN_FILE, "private_file"),
    opencode_password: slot(env.MM_OPENCODE_PASSWORD_FILE, "private_file"),
    callback_targets: slot(env.MM_CALLBACK_TARGETS_FILE, "private_file"),
  };
}

// A management reload must not follow credential-bearing redirects or hang on an
// operator-configured unlimited data-plane timeout. Never return upstream error bodies.
export async function verifyUser(client) {
  const res = await fetch(client.getUserRoute("me"), {
    headers: { authorization: "Bearer " + client.getToken() },
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw serviceError("INVALID_CREDENTIALS");
  }
  const reader = res.body.getReader(),
    chunks = [];
  let n = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > 1024 * 1024) throw serviceError("INVALID_CREDENTIALS");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const me = JSON.parse(Buffer.concat(chunks, n).toString());
  if (typeof me.id !== "string" || !me.id || typeof me.username !== "string")
    throw serviceError("INVALID_CREDENTIALS");
  return me;
}

export async function verifyOpenCode(input, env) {
  if (!env.MM_OPENCODE_URL) return;
  const target = input.targets.resolve({ session_id: "ses_credentialcheck" });
  const res = await fetch(new URL("/api/session?limit=1", target.url), {
    headers: target.headers,
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  await res.body?.cancel();
  if (!res.ok || !res.headers.get("content-type")?.includes("application/json"))
    throw serviceError("INVALID_CREDENTIALS");
}
