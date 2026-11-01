import { listAccessibleChannels, readEventJson } from "./api.js";

async function readDirectorySnapshot(session, signal) {
  const user = await readEventJson(session, session.client.getUserRoute("me"), signal);
  if (user?.id !== session.userId || typeof user.username !== "string" || !user.username)
    throw new Error("Unexpected Mattermost directory account");
  const me = { id: user.id, username: user.username };
  const channels = await listAccessibleChannels(session, signal);
  return { me, channels };
}

// The socket and directory tool share a single writer. An event received while a
// REST read is in flight invalidates that read before it can restore a removed row.
export function createDirectoryRefresh(session, cache) {
  const stop = new AbortController();
  let generation = 0,
    flight;
  async function load() {
    for (let attempt = 0; attempt < 3; attempt++) {
      const version = generation;
      const snapshot = await readDirectorySnapshot(session, stop.signal);
      stop.signal.throwIfAborted();
      if (version !== generation) continue;
      cache.directory.replace(snapshot.me, snapshot.channels);
      cache.retainChannels(snapshot.channels.keys());
      return snapshot;
    }
    throw new Error("Directory changed during refresh; retry the lookup");
  }
  return {
    invalidate(revoked) {
      generation++;
      if (revoked) {
        cache.directory.remove(revoked);
        cache.purgeChannel(revoked);
      }
    },
    async refresh(signal) {
      signal?.throwIfAborted();
      stop.signal.throwIfAborted();
      flight ??= load().finally(() => {
        flight = undefined;
      });
      const result = await flight;
      signal?.throwIfAborted();
      return result;
    },
    async close() {
      stop.abort();
      await flight?.catch(() => {});
    },
  };
}
