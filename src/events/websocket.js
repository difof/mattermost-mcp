import { EventEmitter, on } from "node:events";
import WebSocket from "ws";
import { selectPostedFrame } from "./filter.js";

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
  "direct_added",
  "group_added",
  "leave_team",
  "added_to_team",
  "channel_converted",
  "channel_deleted",
  "channel_restored",
]);

function frameItem(frame, me) {
  // Removal can be sent to the user without a broadcast channel.
  const affectsMe = frame.data?.user_id === me.id || frame.broadcast?.user_id === me.id;
  if (frame.event === "user_removed" && affectsMe)
    return { type: "membership", revoked: frame.data?.channel_id || frame.broadcast?.channel_id };
  if ((frame.event === "user_added" && affectsMe) || membershipEvents.has(frame.event))
    return { type: "membership" };
  const event = selectPostedFrame(frame, me);
  return event ? { type: "post", event, action: frame.event } : null;
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
        const item = frameItem(frame, me);
        if (item) push(item);
      }
    } catch {
      fail();
    }
  });
  return () => clearInterval(ping);
}

export function openEventStream(session, me, signal) {
  signal.throwIfAborted();
  const socket = openSocket(session);
  const queue = new EventEmitter();
  const disconnected = new AbortController();
  const abort = () => disconnected.abort();
  signal.addEventListener("abort", abort, { once: true });
  const stream = on(queue, "item", { signal: disconnected.signal });
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
  return {
    signal: disconnected.signal,
    abort,
    push,
    async *[Symbol.asyncIterator]() {
      for await (const [item] of stream) {
        --queued;
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
