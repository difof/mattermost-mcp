import { EventEmitter, on } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { ResourceGuard } from "../resource-guardrails.js";
import { log } from "../log.js";
import { selectPostedFrame } from "./filter.js";
import { readEventJson } from "./api.js";
import { recoverPosts } from "./recovery.js";

const heartbeatMs = 30_000;
const overlapMs = 60_000;
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
        const event = selectPostedFrame(frame, me);
        if (event) push({ type: "post", event });
      }
    } catch {
      fail();
    }
  });
  return () => clearInterval(ping);
}

async function consume({ session, getCheckpoint, checkpoint, enqueue, onStatus, signal, me }) {
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
    queue.emit("item", item);
  };
  const clearHeartbeat = receive(socket, me, push, abort);
  // A checkpoint is a conservative lower bound. Reconnect always reconciles through
  // hello, including after a process crash; duplicate arrivals collapse in the outbox.
  const advance = async (time) => {
    const safe = time - overlapMs;
    if (safe > (await getCheckpoint())) await checkpoint(safe);
  };
  try {
    for await (const [item] of stream) {
      --queued;
      disconnected.signal.throwIfAborted();
      if (item.type === "connected") {
        onStatus("recovering");
        await recoverPosts({
          session,
          me,
          since: await getCheckpoint(),
          until: item.time,
          enqueue,
          signal: disconnected.signal,
        });
        await advance(item.time);
        onStatus("connected");
      } else if (item.type === "checkpoint") {
        // Pongs are ordered on this connection. Prior frames reached the durable
        // outbox before this marker, even if a history reconciliation was slow.
        await advance(item.time);
      } else if (await new ResourceGuard(session).channelAllowed(item.event.channelId)) {
        await enqueue(item.event);
      }
    }
  } finally {
    clearHeartbeat();
    abort();
    socket.terminate();
    await stream.return();
    signal.removeEventListener("abort", abort);
  }
}

export async function startListener({
  session,
  getCheckpoint,
  checkpoint,
  enqueue,
  onStatus = () => {},
}) {
  // First installation starts now; never generate notifications from pre-install history.
  let baseline = await getCheckpoint();
  if (baseline == null) {
    baseline = Date.now();
    await checkpoint(baseline);
  }
  if (!Number.isSafeInteger(baseline) || baseline <= 0)
    throw new Error("Invalid Mattermost event checkpoint");
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
          getCheckpoint,
          checkpoint,
          enqueue,
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
        log("Mattermost event connection interrupted; retaining checkpoint and retrying");
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
