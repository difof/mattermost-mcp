import { EventEmitter, on } from "node:events";
import WebSocket from "ws";
import { isMattermostId } from "./filter.js";

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

const membershipEvents = new Set([
  "channel_created",
  "direct_added",
  "group_added",
  "leave_team",
  "added_to_team",
]);

// These may reach an entire team, including users who never joined the channel.
const metadataEvents = new Set([
  "channel_updated",
  "channel_converted",
  "channel_deleted",
  "channel_restored",
  "delete_team",
  "restore_team",
]);

function frameItem(frame, userId) {
  // v11 broadcasts some events to a channel, and sends a second copy to the
  // affected user. A frame only invalidates our REST snapshot; it cannot grant access.
  const affectsMe = frame.data?.user_id === userId || frame.broadcast?.user_id === userId;
  if (frame.event === "user_removed" && affectsMe) {
    const id = frame.data?.channel_id || frame.broadcast?.channel_id;
    return { type: "membership", revoked: isMattermostId(id) ? id : undefined };
  }
  if ((frame.event === "user_added" && affectsMe) || membershipEvents.has(frame.event))
    return { type: "membership" };
  if (
    metadataEvents.has(frame.event) ||
    (frame.event === "user_updated" && (affectsMe || frame.data?.user?.id === userId))
  )
    return { type: "directory" };
  if (["posted", "post_edited", "post_deleted"].includes(frame.event))
    return { type: "post", frame };
  return null;
}
function receive(socket, userId, push, fail, invalidate) {
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
        const item = frameItem(frame, userId);
        if (item?.type === "membership") {
          // Stop any in-flight history replay before purging. Queued post frames
          // from the old membership must not reinsert removed content.
          fail();
          invalidate(item.revoked);
          return;
        }
        if (item?.type === "directory") invalidate(undefined, true);
        if (item) push(item);
      }
    } catch {
      fail();
    }
  });
  return () => clearInterval(ping);
}

export function openEventStream(session, signal, invalidate) {
  signal.throwIfAborted();
  const socket = openSocket(session);
  const queue = new EventEmitter();
  const disconnected = new AbortController();
  const abort = () => disconnected.abort();
  signal.addEventListener("abort", abort, { once: true });
  const stream = on(queue, "item", { signal: disconnected.signal });
  socket.on("error", abort);
  socket.on("close", abort);
  let queued = 0,
    directoryQueued = false;
  const push = (item) => {
    if (disconnected.signal.aborted) return;
    if (item.type === "directory") {
      if (directoryQueued) return;
      directoryQueued = true;
    }
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
  const clearHeartbeat = receive(socket, session.userId, push, abort, invalidate);
  return {
    signal: disconnected.signal,
    abort,
    push,
    async *[Symbol.asyncIterator]() {
      for await (const [item] of stream) {
        --queued;
        if (item.type === "directory") directoryQueued = false;
        if (queued <= maxQueuedFrames / 4 && socket.isPaused) socket.resume();
        disconnected.signal.throwIfAborted();
        yield item;
      }
    },
    async close() {
      clearHeartbeat();
      abort();
      socket.terminate();
      signal.removeEventListener("abort", abort);
      await stream.return();
    },
  };
}
