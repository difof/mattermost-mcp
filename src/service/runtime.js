import { createSession } from "../mattermost/client.js";
import { readInputs, secretStatus, serviceError, sessionConfig } from "./inputs.js";
import { requestGate } from "./request-gate.js";
import { credentialHistory, prepareSettingsChange } from "./settings-change.js";
import {
  SETTING_INFO,
  settingsFile,
  readOverrides,
  writeOverrides,
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

function report({ state, env, boundPort }) {
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

async function rollback(steps) {
  let failed = false;
  for (const step of steps) {
    try {
      await step();
    } catch {
      failed = true;
    }
  }
  if (failed) throw serviceError("ROLLBACK_FAILED");
}

async function applyChange(runtime, operation) {
  const { state: old, gate, file } = runtime;
  const { next, overrides, changed, newClient, restartEvents } = await prepareSettingsChange(
    runtime,
    operation,
  );
  const stage = restartEvents ? await events(next, true) : undefined;
  const undo = [];
  if (stage) undo.push(stage);
  let paused = false;
  try {
    await gate.pause();
    paused = true;
    // A local editor may have changed the settings while waiting for requests to drain.
    if (readOverrides(file).revision !== next.disk.revision)
      throw serviceError("REVISION_CONFLICT");
    if (operation.mode === "set") {
      next.disk = writeOverrides(file, overrides, next.disk.revision);
      if (next.disk.revision !== old.disk.revision) {
        undo.push(() => writeOverrides(file, old.disk.overrides, next.disk.revision));
      }
    }
    if (restartEvents) {
      if (old.stop) {
        undo.push(async () => {
          old.stop = await events(old);
        });
        await old.stop();
      }
      await stage?.activate();
      next.stop = stage;
    } else if (!newClient) {
      // Retain the session already captured by the active listener.
      old.session.config = next.session.config;
      next.session = old.session;
      next.stop = old.stop;
    }
    Object.assign(runtime.http, httpValues(next, runtime.boundPort));
    runtime.credentials.remember(runtime.http);
    runtime.state = next;
    return { ...report(runtime), changed, reloaded: operation.mode === "reload" };
  } catch (error) {
    // Release the candidate, restore the file, then restart the old listener.
    await rollback(undo);
    throw error;
  } finally {
    if (paused) gate.resume();
  }
}

export async function serviceRuntime(env = { ...process.env }) {
  const file = settingsFile(env);
  const input = readInputs(env);
  const disk = readOverrides(file);
  const values = effectiveSettings(input.defaults, disk.overrides);
  const session = await createSession(sessionConfig(input.config, values));
  const state = { input, disk, values, session, stop: undefined, loadedAt: Date.now() };
  const boundPort = values.http_port;
  const http = httpValues(state, boundPort);
  const credentials = credentialHistory();
  credentials.remember(http);
  let ready = false,
    closed = false,
    pending;
  const gate = requestGate(() => (ready ? runtime.state.session : null));
  const runtime = { env, file, boundPort, credentials, state, http, gate };

  function update(operation) {
    if (pending || closed || !ready) throw serviceError("BUSY");
    pending = applyChange(runtime, operation).finally(() => {
      pending = undefined;
    });
    return pending;
  }
  return {
    http,
    getSession: gate,
    admin: {
      list: () => report(runtime),
      set: (patch, expected) => update({ mode: "set", patch, expected }),
      reload: (expected) => update({ mode: "reload", expected }),
    },
    async start() {
      runtime.state.stop = await events(runtime.state);
      ready = true;
    },
    async close() {
      closed = true;
      await pending?.catch(() => {});
      ready = false;
      await runtime.state.stop?.();
    },
  };
}
