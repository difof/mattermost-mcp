import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { log } from "../log.js";
import { readSecretFile } from "../service/secret.js";
import { startListener } from "./listener.js";
import { openOutbox } from "./outbox.js";
import { openCodeDelivery, startDelivery } from "./delivery.js";

export function eventSettings(env = process.env) {
  const url = new URL(env.MM_OPENCODE_URL ?? "http://127.0.0.1:4096");
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("MM_OPENCODE_URL must be an HTTP loopback origin");
  }
  const sessionId = env.MM_OPENCODE_SESSION_ID;
  if (!/^ses_[A-Za-z0-9]+$/.test(sessionId ?? ""))
    throw new Error("Set a valid MM_OPENCODE_SESSION_ID");
  if (!env.MM_OPENCODE_PASSWORD_FILE) throw new Error("Set MM_OPENCODE_PASSWORD_FILE");
  const password = readSecretFile(env.MM_OPENCODE_PASSWORD_FILE);
  if (!password || /[\r\n\0]/.test(password)) throw new Error("Invalid OpenCode password file");
  const stateDir =
    env.MM_EVENTS_STATE_DIR ||
    join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "mattermost-mcp");
  if (!isAbsolute(stateDir)) throw new Error("MM_EVENTS_STATE_DIR must be absolute");
  return { url: url.origin, sessionId, password, stateDir };
}

export async function startEvents({ config, session }) {
  const settings = eventSettings();
  const account = JSON.stringify([config.url, session.userId]);
  const scope = [
    account,
    settings.url,
    settings.sessionId,
    [...config.guardrails.teamAllowlist].sort(),
    [...config.guardrails.channelAllowlist].sort(),
  ];
  const key = createHash("sha256").update(JSON.stringify(scope)).digest("hex");
  const outbox = openOutbox(join(settings.stateDir, key + ".json"));
  const pump = startDelivery(outbox, openCodeDelivery({ ...settings, account }));
  try {
    const stop = await startListener({
      session,
      onStatus(state) {
        if (state === "connected") log("Mattermost event listener connected; catch-up complete");
      },
      getCheckpoint: outbox.getCheckpoint,
      checkpoint: outbox.checkpoint,
      enqueue(event) {
        outbox.enqueue(event);
        pump.wake();
      },
    });
    return async () => {
      try {
        await stop();
      } finally {
        await pump.stop();
      }
    };
  } catch (error) {
    await pump.stop();
    throw error;
  }
}
