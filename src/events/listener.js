import { EventEmitter, on } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { log } from "../log.js";
import { isMattermostId, selectPostedFrame } from "./filter.js";
import { listAccessibleChannels, readEventJson } from "./api.js";
import { recoverPosts } from "./recovery.js";
import { RETENTION_MS } from "./cache.js";

const heartbeatMs = 30_000;
const maxQueuedFrames = 512;

// Authenticate the WebSocket upgrade, not its URL. Never forward the credential to redirects.
function openSocket(session) {
  const url = new URL(session.client.getBaseRoute() + "/websocket");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(url, {
    headers: { Authorization: "Bearer " + session.client.getToken() },
    followRedirects: false,
    perMessageDeflate: false,
    maxPayload: 4 * 1024 * 1024,
    handshakeTimeout: 15_000,
  });
}

function receive(socket, me, push, fail) {
  let nextSequence,
    hello = false;
  let pingTime = 0,
    helloDeadline = Date.now() + heartbeatMs;
  const ping = setInterval(() => {
    if (!hello || pingTime) {
      if (hello || Date.now() >= helloDeadline) fail();
      return;
    }
    pingTime = Date.now();
    if (socket.readyState === WebSocket.OPEN) socket.ping();
  }, heartbeatMs);
  socket.on("pong", () => {
    if (pingTime > 0) push({ type: "checkpoint", time: pingTime });
    pingTime = 0;
  });
  socket.on("message", (bytes) => {
    try {
      const frame = JSON.parse(bytes.toString());
      if (!frame.event) return; // action replies do not participate in event sequence numbering
      if (
        !Number.isSafeInteger(frame.seq) ||
        (nextSequence !== undefined && frame.seq !== nextSequence)
      ) {
        fail();
        return;
      }
      nextSequence = frame.seq + 1;
      if (frame.event === "hello") {
        if (hello) return fail();
        hello = true;
        push({ type: "connected", time: Date.now() });
      } else {
        if (!hello) return fail();
        // Losing a channel is sent directly to the removed user, without broadcast.channel_id.
        const recipient = frame.broadcast?.user_id;
        if (
          frame.event === "user_removed" &&
          (frame.data?.user_id === me.id || recipient === me.id)
        ) {
          push({
            type: "membership",
            revoked: frame.data?.channel_id || frame.broadcast?.channel_id,
          });
          return;
        }
        if (
          (frame.event === "user_added" &&
            (frame.data?.user_id === me.id || recipient === me.id)) ||
          [
            "direct_added",
            "group_added",
            "leave_team",
            "added_to_team",
            "channel_converted",
            "channel_deleted",
            "channel_restored",
          ].includes(frame.event)
        ) {
          push({ type: "membership" });
          return;
        }
        const event = selectPostedFrame(frame, me);
        if (event) push({ type: "post", event, action: frame.event });
      }
    } catch {
      fail();
    }
  });
  return () => clearInterval(ping);
}

async function consume({ session, cache, onStatus, signal, me }) {
  const queue = new EventEmitter();
  const disconnected = new AbortController();
  const abort = () => disconnected.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const stream = on(queue, "item", { signal: disconnected.signal });
  const socket = openSocket(session);
  socket.on("error", abort);
  socket.on("close", abort);
  let queued = 0;
  const push = (item) => {
    if (disconnected.signal.aborted) return;
    if (++queued > maxQueuedFrames) {
      abort();
      return;
    }
    // Only the membership lookup/short DB operations block this consumer. Large history
    // scans run alongside it; pause the socket at high water rather than restarting
    // reconciliation over and over on a busy deployment.
    if (queued === maxQueuedFrames / 2) socket.pause();
    queue.emit("item", item);
  };
  const clearHeartbeat = receive(socket, me, push, abort);
  let channels,
    recovery,
    recovered = false;
  try {
    for await (const [item] of stream) {
      --queued;
      if (queued <= maxQueuedFrames / 4 && socket.isPaused) socket.resume();
      disconnected.signal.throwIfAborted();
      if (item.type === "connected") {
        onStatus("recovering");
        channels = await listAccessibleChannels(session, disconnected.signal);
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
          signal: disconnected.signal,
        }).then(() => push({ type: "ready", time: item.time }), abort);
      } else if (item.type === "ready") {
        recovered = true;
        await cache.checkpoint(item.time);
        onStatus("connected");
      } else if (item.type === "checkpoint") {
        if (recovered) await cache.checkpoint(item.time);
      } else if (item.type === "membership") {
        abort();
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
    clearHeartbeat();
    abort();
    socket.terminate();
    await stream.return();
    await recovery;
    signal.removeEventListener("abort", abort);
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
            if (state === "connected") failures = 0;
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
