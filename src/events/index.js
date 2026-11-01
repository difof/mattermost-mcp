import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { log } from "../log.js";
import { openCache } from "./cache.js";
import { callbackTargets } from "./callbacks.js";
import { createSubscriptions } from "./subscriptions.js";
import { listAccessibleChannels } from "./api.js";
import { startListener } from "./listener.js";

export async function startEvents({ config, session }) {
  const targets = callbackTargets();
  const dir =
    process.env.MM_EVENTS_STATE_DIR ||
    join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "mattermost-mcp");
  if (!isAbsolute(dir)) throw new Error("MM_EVENTS_STATE_DIR must be absolute");
  const account = JSON.stringify([config.url, session.userId]);
  const scope = createHash("sha256")
    .update(
      JSON.stringify([
        account,
        [...config.guardrails.teamAllowlist].sort(),
        [...config.guardrails.channelAllowlist].sort(),
      ]),
    )
    .digest("hex");
  const cache = await openCache(join(dir, "cache", scope + ".sqlite3"));
  let subscriptions, timer, stop;
  const close = async () => {
    clearInterval(timer);
    try {
      if (stop) await stop();
    } finally {
      try {
        if (subscriptions) await subscriptions.stop();
      } finally {
        delete session.cacheStatus;
        delete session.cache;
        delete session.subscriptions;
        cache.close();
      }
    }
  };
  try {
    subscriptions = createSubscriptions({
      cache,
      targets,
      account,
      authorize: async (signal) => {
        const channels = await listAccessibleChannels(session, signal);
        cache.retainChannels(channels.keys());
      },
    });
    session.cacheStatus = "connecting";
    session.cache = cache;
    session.subscriptions = subscriptions;
    timer = setInterval(() => {
      try {
        cache.prune();
      } catch {
        log("Message cache expiry cleanup delayed");
      }
    }, 60000);
    timer.unref();
    stop = await startListener({
      session,
      checkpoint: cache.checkpoint,
      enqueue(record) {
        cache.apply(record);
        subscriptions.wake();
      },
      enqueueBatch(records) {
        cache.applyBatch(records);
        subscriptions.wake();
      },
      retainChannels: cache.retainChannels,
      purgeChannel: cache.purgeChannel,
      cachedIds: cache.cachedIds,
      reconcileMissing: cache.reconcileMissing,
      onStatus(state) {
        session.cacheStatus = state;
        if (state === "connected")
          log("Mattermost message cache connected; 48-hour catch-up complete");
      },
    });
    return close;
  } catch (error) {
    await close();
    throw error;
  }
}
