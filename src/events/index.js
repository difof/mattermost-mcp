import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { log } from "../log.js";
import { DEFAULT_RETENTION_HOURS, openCache } from "./cache.js";
import { callbackTargets } from "./callbacks.js";
import { postAccess } from "./post-presentation.js";
import { createSubscriptions } from "./subscriptions.js";
import { cacheAccess } from "./cache-access.js";
import { openDirectory } from "./directory.js";
import { createDirectoryRefresh } from "./directory-refresh.js";
import { startListener } from "./listener.js";

function defaultStateDir() {
  return (
    process.env.MM_EVENTS_STATE_DIR ||
    join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "mattermost-mcp")
  );
}

/** A staged runtime can be discarded before activation without pruning data or dispatching callbacks. */
export async function startEvents({
  config,
  session,
  retentionHours = DEFAULT_RETENTION_HOURS,
  targets = callbackTargets(),
  stateDir = defaultStateDir(),
  deferActivation = false,
}) {
  if (!isAbsolute(stateDir)) throw new Error("MM_EVENTS_STATE_DIR must be absolute");
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
  // Retention and credentials are not part of the identity: preserve cursors and leases on reload.
  const cache = await openCache(join(stateDir, "cache", scope + ".sqlite3"), {
    retentionHours,
    deferPrune: true,
  });
  let subscriptions, timer, stopListener, closing, directory;

  const close = () =>
    (closing ??= (async () => {
      clearInterval(timer);
      const results = await Promise.allSettled([
        stopListener?.(),
        subscriptions?.stop(),
        directory?.close(),
      ]);
      // An unactivated candidate may reference the same session as the active service.
      if (session.cache === cache) {
        delete session.cacheStatus;
        delete session.cacheHealth;
        delete session.cache;
        delete session.subscriptions;
      }
      cache.close();
      const failed = results.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
    })());

  close.activate = async () => {
    if (closing) throw new Error("Cannot activate a closed event runtime");
    if (stopListener) return;
    // Validation and all SQL statement preparation finished while the old runtime was live.
    // Shrinking retention and revoking removed callback destinations commit together.
    cache.transaction(() => {
      cache.prune();
      subscriptions.revokeDisabledTargets();
    });
    session.cacheStatus = "connecting";
    session.cacheHealth = { lastCompleteAt: null, failedChannels: 0, ambiguousChannels: 0 };
    session.cache = cache;
    session.subscriptions = subscriptions;
    if (!config.guardrails.readOnly) subscriptions.start();
    timer = setInterval(() => {
      try {
        cache.prune();
        subscriptions.prune();
      } catch {
        log("Message cache expiry cleanup delayed");
      }
    }, 60000);
    timer.unref();
    stopListener = startListener({
      session,
      refreshDirectory: directory.refresh,
      invalidateDirectory: directory.invalidate,
      watchMembership: directory.watch,
      retentionMs: cache.retentionMs,
      checkpoint: cache.checkpoint,
      enqueue(record) {
        cache.apply(record);
        subscriptions.wake();
      },
      enqueueBatch(records) {
        cache.applyBatch(records, { authoritative: true });
        subscriptions.wake();
      },
      purgeChannel: cache.purgeChannel,
      cachedIds: cache.cachedIds,
      reconcileMissing: cache.reconcileMissing,
      onStatus(state, health) {
        Object.assign(session.cacheHealth, health);
        session.cacheStatus = state;
        if (state === "connected")
          log(`Mattermost message cache connected; ${retentionHours}-hour catch-up complete`);
        else if (state === "partial")
          log("Mattermost message cache live; history partially reconciled");
      },
    });
  };

  try {
    cache.directory = openDirectory(cache);
    directory = createDirectoryRefresh(session, cache);
    cache.refreshDirectory = directory.refresh;
    cache.refreshMembership = (signal) => directory.refresh(signal, false);
    cache.directoryPage = directory.page;
    subscriptions = createSubscriptions({
      cache,
      targets,
      account,
      deferred: true,
      authorize: async (ids, signal, records) => {
        const access = await cacheAccess(session, cache, signal);
        await access.check(ids, { partial: true });
        const posts = postAccess(session, cache, access, signal);
        if (!posts) return access.decision;
        await posts.check(
          records.filter((row) => access.allows(row.channelId)),
          { partial: true },
        );
        return (id, row) =>
          access.decision(id) !== true ? access.decision(id) : posts.allows(row) ? true : undefined;
      },
    });
    if (!deferActivation) await close.activate();
    return close;
  } catch (error) {
    await close();
    throw error;
  }
}
