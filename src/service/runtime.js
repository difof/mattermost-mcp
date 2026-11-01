import { createHash } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { createSession } from "../mattermost/client.js";
import {
  readInputs,
  secretStatus,
  serviceError,
  sessionConfig,
  verifyOpenCode,
  verifyUser,
} from "./inputs.js";
import { requestGate } from "./request-gate.js";
import {
  SETTING_INFO,
  settingsFile,
  readOverrides,
  writeOverrides,
  patchOverrides,
  effectiveSettings,
} from "./settings.js";

async function events(state, staged = false) {
  if (!state.values.events_enabled) return undefined;
  const { startEvents } = await import("../events/index.js");
  return startEvents({
    config: state.session.config,
    session: state.session,
    retentionHours: state.values.retention_hours,
    targets: state.input.targets,
    stateDir: state.input.stateDir,
    deferActivation: staged,
  });
}
function httpValues(state, port) {
  return {
    ...state.input.http,
    port,
    maxBodyBytes: state.values.http_max_body_bytes,
    eventsEnabled: state.values.events_enabled,
  };
}
function changedKeys(previous, next) {
  return Object.keys(next).filter((k) => previous[k] !== next[k]);
}
function cloneSession(old, config) {
  const { cache: _c, cacheStatus: _s, subscriptions: _l, ...core } = old;
  return { ...core, config };
}

export async function serviceRuntime(env = { ...process.env }) {
  const file = settingsFile(env);
  const input = readInputs(env),
    disk = readOverrides(file),
    values = effectiveSettings(input.defaults, disk.overrides);
  let state = {
    input,
    disk,
    values,
    session: await createSession(sessionConfig(input.config, values)),
    stop: undefined,
    loadedAt: Date.now(),
  };
  const boundPort = values.http_port,
    http = httpValues(state, boundPort);
  let ready = false,
    pending;
  const gate = requestGate(() => (ready ? state.session : null));
  // A previously distributed data bearer must never become the admin credential on reload.
  const digest = (secret) => secret && createHash("sha256").update(secret).digest("hex");
  const seenData = new Set([digest(http.token)]),
    seenAdmin = new Set(http.adminToken ? [digest(http.adminToken)] : []);
  let busy = false,
    closed = false;

  function list() {
    return {
      revision: state.disk.revision,
      loaded_at: state.loadedAt,
      settings: Object.fromEntries(
        Object.entries(SETTING_INFO).map(([key, info]) => [
          key,
          {
            ...info,
            value: key === "http_port" ? boundPort : state.values[key],
            desired: state.values[key],
            source: Object.hasOwn(state.disk.overrides, key) ? "override" : "bootstrap",
          },
        ]),
      ),
      secrets: secretStatus(env, state.input.config),
      account_id: state.session.userId,
      restart_required: state.values.http_port === boundPort ? [] : ["http_port"],
    };
  }

  async function prepare(old, mode, patch, expected) {
    if (expected !== undefined && expected !== old.disk.revision)
      throw serviceError("REVISION_CONFLICT");
    const stored = readOverrides(file);
    if (mode === "set" && stored.revision !== old.disk.revision)
      throw serviceError("REVISION_CONFLICT");
    const overrides = mode === "set" ? patchOverrides(stored.overrides, patch) : stored.overrides;
    let input = old.input;
    if (mode === "reload") {
      try {
        input = readInputs(env);
      } catch (e) {
        throw e.code === "INVALID_SETTINGS" ? e : serviceError("INVALID_CREDENTIALS");
      }
      if (seenData.has(digest(input.http.adminToken)) || seenAdmin.has(digest(input.http.token)))
        throw serviceError("INVALID_CREDENTIALS");
      // Bind the service lifetime to one original server and account. Check the origin
      // before making any request with replacement credentials.
      if (
        input.config.url !== old.input.config.url ||
        input.config.auth.mode !== old.input.config.auth.mode
      )
        throw serviceError("ACCOUNT_MISMATCH");
    }
    const values = effectiveSettings(input.defaults, overrides);
    const config = sessionConfig(input.config, values),
      changed = changedKeys(old.values, values);
    const newClient =
      !equal(config.resilience, old.session.config.resilience) ||
      !equal(config.auth, old.session.config.auth);
    let session;
    try {
      if (newClient) session = await createSession(config, { verify: verifyUser });
      else {
        session = cloneSession(old.session, config);
        if (mode === "reload" && (await verifyUser(session.client)).id !== old.session.userId)
          throw serviceError("ACCOUNT_MISMATCH");
      }
      if (mode === "reload" && values.events_enabled) await verifyOpenCode(input, env);
    } catch (e) {
      throw e.code === "ACCOUNT_MISMATCH" ? e : serviceError("INVALID_CREDENTIALS");
    }
    if (session.userId !== old.session.userId) throw serviceError("ACCOUNT_MISMATCH");
    const restartEvents =
      (old.values.events_enabled || values.events_enabled) &&
      (mode === "reload" ||
        newClient ||
        changed.some((k) => ["read_only", "retention_hours", "events_enabled"].includes(k)));
    return {
      next: { input, disk: stored, values, session, stop: undefined, loadedAt: Date.now() },
      overrides,
      changed,
      newClient,
      restartEvents,
    };
  }

  async function apply(mode, patch, expected) {
    if (busy || closed || !ready) throw serviceError("BUSY");
    busy = true;
    const old = state;
    let stage,
      hold = false,
      saved,
      stopped = false;
    try {
      const { next, overrides, changed, newClient, restartEvents } = await prepare(
        old,
        mode,
        patch,
        expected,
      );
      if (restartEvents && next.values.events_enabled) stage = await events(next, true);
      await gate.pause();
      hold = true;
      const onDisk = readOverrides(file);
      if (onDisk.revision !== next.disk.revision) throw serviceError("REVISION_CONFLICT");
      if (mode === "set") {
        saved = writeOverrides(file, overrides, onDisk.revision);
        next.disk = saved;
      }
      if (restartEvents) {
        stopped = Boolean(old.stop);
        if (old.stop) await old.stop();
        if (stage) await stage.activate();
        next.stop = stage;
      } else if (!newClient) {
        // Most limits only need a config swap. Keep the captured session used by the live listener.
        old.session.config = next.session.config;
        next.session = old.session;
        next.stop = old.stop;
      }
      Object.assign(http, httpValues(next, boundPort));
      seenData.add(digest(http.token));
      if (http.adminToken) seenAdmin.add(digest(http.adminToken));
      state = next;
      return { ...list(), changed, reloaded: mode === "reload" };
    } catch (error) {
      let failed = false;
      if (stage)
        try {
          await stage();
        } catch {
          failed = true;
        }
      if (saved && saved.revision !== old.disk.revision)
        try {
          writeOverrides(file, old.disk.overrides, saved.revision);
        } catch {
          failed = true;
        }
      if (stopped)
        try {
          old.stop = await events(old);
        } catch {
          failed = true;
        }
      if (failed) throw serviceError("ROLLBACK_FAILED");
      throw error;
    } finally {
      if (hold) gate.resume();
      busy = false;
    }
  }
  function update(mode, patch, expected) {
    if (busy || closed || !ready) throw serviceError("BUSY");
    pending = apply(mode, patch, expected);
    return pending;
  }
  return {
    http,
    getSession: gate,
    admin: {
      list,
      set: (patch, expected) => update("set", patch, expected),
      reload: (expected) => update("reload", undefined, expected),
    },
    async start() {
      state.stop = await events(state);
      ready = true;
    },
    async close() {
      closed = true;
      await pending?.catch(() => {});
      ready = false;
      await state.stop?.();
    },
  };
}
