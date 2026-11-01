import { setTimeout as sleep } from "node:timers/promises";
import { openEventStream } from "./websocket.js";
import { log } from "../log.js";
import { isMattermostId } from "./filter.js";
import { listAccessibleChannels, readEventJson } from "./api.js";
import { recoverPosts } from "./recovery.js";
import { RETENTION_MS } from "./cache.js";

async function consume({ session, cache, onStatus, signal, me }) {
  const stream = openEventStream(session, me, signal);
  let channels,
    recovery,
    recovered = false;
  try {
    for await (const item of stream) {
      if (item.type === "connected") {
        onStatus("recovering");
        channels = await listAccessibleChannels(session, stream.signal);
        await cache.retainChannels(channels.keys());
        // A timestamp-only incremental scan misses older posts edited/deleted offline.
        // Reconcile precisely the retained window; live events continue during pagination.
        recovery = recoverPosts({
          session,
          channels,
          me,
          since: item.time - cache.retentionMs,
          until: item.time,
          cache,
          signal: stream.signal,
        }).then(
          (complete) => stream.push({ type: "ready", complete, time: item.time }),
          stream.abort,
        );
      } else if (item.type === "ready") {
        recovered = item.complete;
        if (recovered) await cache.checkpoint(item.time);
        onStatus(recovered ? "connected" : "partial");
      } else if (item.type === "checkpoint") {
        if (recovered) await cache.checkpoint(item.time);
      } else if (item.type === "membership") {
        stream.abort();
        if (isMattermostId(item.revoked)) await cache.purgeChannel(item.revoked);
        break;
      } else {
        const channel = channels?.get(item.event.channelId);
        if (channel) {
          if (!item.event.deleted) item.event.channelType = channel.type;
          await cache.enqueue(item.event, item.action);
        }
      }
    }
  } finally {
    await stream.close();
    await recovery;
  }
  if (!signal.aborted) throw new Error("Reconnect for membership change");
}

export function startListener({
  session,
  retentionMs = RETENTION_MS,
  checkpoint,
  enqueue,
  enqueueBatch,
  retainChannels,
  purgeChannel,
  cachedIds,
  reconcileMissing,
  onStatus = () => {},
}) {
  const cache = {
    retentionMs,
    checkpoint,
    enqueue,
    enqueueBatch,
    retainChannels,
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
        const me = await readEventJson(session, session.client.getUserRoute("me"), signal);
        if (!me.username || me.id !== session.userId)
          throw new Error("Unexpected account on event connection");
        signal.throwIfAborted();
        await consume({
          session,
          cache,
          me,
          signal,
          onStatus: (state) => {
            if (state === "connected" || state === "partial") failures = 0;
            onStatus(state);
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
