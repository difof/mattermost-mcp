import { setTimeout as sleep } from "node:timers/promises";
import { recoverPosts } from "./recovery.js";

// The socket keeps processing live frames while unavailable rooms recover on
// their own schedule. Do not restart a complete replay of healthy rooms.
export async function recoverUntilReady({ session, snapshot, channels, cache, stream, time }) {
  let pending = new Map(channels),
    delay = 1000;
  const ambiguous = new Set();
  do {
    const failed = new Map();
    await recoverPosts({
      session,
      channels: pending,
      me: snapshot.me,
      since: time - cache.retentionMs,
      until: time,
      cache,
      signal: stream.signal,
      current: snapshot.isCurrent,
      onDenied(id) {
        snapshot.denyContent(id);
        channels.delete(id);
      },
      onAmbiguous: (channel) => ambiguous.add(channel.id),
      onUnavailable: (channel) => failed.set(channel.id, channel),
    });
    stream.signal.throwIfAborted();
    const failedChannels = failed.size,
      ambiguousChannels = ambiguous.size;
    stream.push({
      type: "ready",
      complete: failedChannels === 0 && ambiguousChannels === 0,
      time,
      failedChannels,
      ambiguousChannels,
    });
    pending = failed;
    if (pending.size) {
      await sleep(delay, undefined, { signal: stream.signal });
      delay = Math.min(delay * 2, 60000);
    }
  } while (pending.size);
}
