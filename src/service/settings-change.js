import { createHash } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { inheritUploadProtection } from "../mattermost/upload-access.js";
import { createSession } from "../mattermost/client.js";
import { readInputs, serviceError, sessionConfig, verifyOpenCode, verifyUser } from "./inputs.js";
import { effectiveSettings, patchOverrides, readOverrides } from "./settings.js";

const listenerSettings = new Set(["read_only", "retention_hours", "events_enabled"]);

// Neither HTTP bearer may take the other role, even after intervening rotations.
export function credentialHistory() {
  const data = new Set();
  const admin = new Set();
  const digest = (value) => value && createHash("sha256").update(value).digest("hex");
  return {
    remember({ token, adminToken }) {
      data.add(digest(token));
      if (adminToken) admin.add(digest(adminToken));
    },
    check({ token, adminToken }) {
      if (data.has(digest(adminToken)) || admin.has(digest(token))) {
        throw serviceError("INVALID_CREDENTIALS");
      }
    },
  };
}

function reloadInputs(previous, env, credentials) {
  let input;
  try {
    input = readInputs(env);
  } catch (error) {
    throw error.code === "INVALID_SETTINGS" ? error : serviceError("INVALID_CREDENTIALS");
  }
  inheritUploadProtection(previous.config.uploads?.access, input.config.uploads?.access);
  credentials.check(input.http);
  // Reject a new origin or auth mechanism before sending replacement credentials.
  if (
    input.config.url !== previous.config.url ||
    input.config.auth.mode !== previous.config.auth.mode
  ) {
    throw serviceError("ACCOUNT_MISMATCH");
  }
  return input;
}

async function candidateSession(old, config, newClient, reload) {
  if (newClient) return createSession(config, { verify: verifyUser });
  // The live listener owns these fields; the staged session must not inherit them.
  const { cache: _c, cacheStatus: _s, subscriptions: _l, ...core } = old;
  if (reload && (await verifyUser(old.client)).id !== old.userId)
    throw serviceError("ACCOUNT_MISMATCH");
  return { ...core, config };
}

/** Validate the whole change before draining requests or mutating the live session. */
export async function prepareSettingsChange(runtime, { mode, patch, expected }) {
  const { state: old, env, file, credentials } = runtime;
  if (expected !== undefined && expected !== old.disk.revision)
    throw serviceError("REVISION_CONFLICT");
  const disk = readOverrides(file);
  const reload = mode === "reload";
  if (!reload && disk.revision !== old.disk.revision) {
    throw serviceError("REVISION_CONFLICT");
  }
  const overrides = reload ? disk.overrides : patchOverrides(disk.overrides, patch);
  const input = reload ? reloadInputs(old.input, env, credentials) : old.input;
  const values = effectiveSettings(input.defaults, overrides);
  const config = sessionConfig(input.config, values);
  const previous = old.session.config;
  const newClient =
    !equal(config.resilience, previous.resilience) ||
    !equal(config.auth, previous.auth) ||
    config.maxResponseBytes !== previous.maxResponseBytes;
  let session;
  try {
    session = await candidateSession(old.session, config, newClient, reload);
    if (session.userId !== old.session.userId) throw serviceError("ACCOUNT_MISMATCH");
    if (reload && values.events_enabled) await verifyOpenCode(input, env);
  } catch (error) {
    throw error.code === "ACCOUNT_MISMATCH" ? error : serviceError("INVALID_CREDENTIALS");
  }
  const changed = Object.keys(values).filter((key) => values[key] !== old.values[key]);
  const restartEvents =
    (old.values.events_enabled || values.events_enabled) &&
    (reload || newClient || changed.some((key) => listenerSettings.has(key)));
  return {
    next: { input, disk, values, session, stop: undefined, loadedAt: Date.now() },
    overrides,
    changed,
    newClient,
    restartEvents,
  };
}
