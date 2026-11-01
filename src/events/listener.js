import { setTimeout as sleep } from "node:timers/promises";
import { openEventStream } from "./websocket.js";
import { log } from "../log.js";
import { selectPostedFrame } from "./filter.js";
import { recoverUntilReady } from "./recovery-loop.js";
import { readEventJson } from "./api.js";
import { RETENTION_MS } from "./cache.js";

async function consume({ session, cache, onStatus, signal }) {
  const stream = openEventStream(session, signal, cache.invalidateDirectory);
  let snapshot,
    unwatch,
    me,
    channels,
    joined,
    recovery,
    recovered = false;
  try {
    for await (const item of stream) {
      if (item.type === "connected") {
        onStatus("recovering");
        snapshot = await cache.refreshDirectory(stream.signal);
        ({ me, channels: joined } = snapshot);
        unwatch = cache.watchMembership?.(stream.abort);
        // Recovery can deny post content even when metadata membership remains.
        channels = new Map(joined);
        // A timestamp-only incremental scan misses older posts edited/deleted offline.
        // Reconcile precisely the retained window; live events continue during pagination.
        recovery = recoverUntilReady({
          session,
          snapshot,
          channels,
          cache,
          stream,
          time: item.time,
        }).catch(stream.abort);
      } else if (item.type === "ready") {
        recovered = item.complete;
        if (recovered) await cache.checkpoint(item.time);
        onStatus(recovered ? "connected" : "partial", {
          failedChannels: item.failedChannels,
          ambiguousChannels: item.ambiguousChannels,
          ...(recovered ? { lastCompleteAt: Date.now() } : {}),
        });
      } else if (item.type === "checkpoint") {
        if (recovered) await cache.checkpoint(item.time);
      } else if (item.type === "directory") {
        const next = await cache.refreshDirectory(stream.signal);
        // A metadata change usually only renames a channel/account. If the
        // membership set also changed, reconnect to recover newly visible history.
        if (
          joined.size !== next.channels.size ||
          [...joined].some(([id, ch]) => ch.type !== next.channels.get(id)?.type)
        ) {
          stream.abort();
          break;
        }
        snapshot = next;
        me = next.me;
      } else {
        const event = selectPostedFrame(item.frame, me);
        const channel = event && channels.get(event.channelId);
        if (channel && snapshot.isCurrent(channel.id)) {
          if (!event.deleted) event.channelType = channel.type;
          await cache.enqueue(event, item.frame.event);
        }
      }
    }
  } finally {
    unwatch?.();
    await stream.close();
    await recovery;
  }
  if (!signal.aborted) throw new Error("Reconnect for membership change");
}

export function startListener({
  session,
  refreshDirectory,
  invalidateDirectory,
  watchMembership,
  retentionMs = RETENTION_MS,
  checkpoint,
  enqueue,
  enqueueBatch,
  purgeChannel,
  cachedIds,
  reconcileMissing,
  onStatus = () => {},
}) {
  const cache = {
    refreshDirectory,
    invalidateDirectory,
    watchMembership,
    retentionMs,
    checkpoint,
    enqueue,
    enqueueBatch,
    purgeChannel,
    cachedIds,
    reconcileMissing,
  };
  const controller = new AbortController();
  const { signal } = controller;
  const run = async () => {
    let failures = 0;
    while (!signal.aborted) {
      try {
        onStatus("connecting");
        const mode = session.config.auth?.mode;
        if (failures && ["oauth2", "password"].includes(mode)) {
          // A rejected socket upgrade has no REST response to trigger token recovery.
          const me = await readEventJson(session, session.client.getUserRoute("me"), signal);
          if (me?.id !== session.userId) throw new Error("Unexpected Mattermost event account");
        }
        await consume({
          session,
          cache,
          signal,
          onStatus: (state, health) => {
            if (state === "connected" || state === "partial") failures = 0;
            onStatus(state, health);
          },
        });
      } catch {
        if (signal.aborted) break;
        onStatus("reconnecting");
        const delay = Math.min(60_000, 1_000 * 2 ** Math.min(failures++, 6));
        log("Mattermost event connection interrupted; reconnecting and reconciling cache");
        await sleep(delay + Math.random() * delay * 0.2, undefined, { signal }).catch(() => {});
      }
    }
    onStatus("stopped");
  };
  const running = run();
  return async () => {
    controller.abort();
    await running;
  };
}
