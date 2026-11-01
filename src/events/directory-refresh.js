import { randomUUID } from "node:crypto";
import { withRequestSignal } from "../mattermost/request-signal.js";
import { listAccessibleChannels, readEventJson } from "./api.js";

async function account(session, signal) {
  const user = await readEventJson(session, session.client.getUserRoute("me"), signal);
  if (user?.id !== session.userId || typeof user.username !== "string" || !user.username)
    throw new Error("Unexpected Mattermost directory account");
  return { id: user.id, username: user.username };
}

// A grant identifies one continuous membership, not merely a channel ID. Old REST
// and socket work cannot regain permission when the account leaves and later rejoins.
export function createDirectoryRefresh(session, cache) {
  const stop = new AbortController();
  const watchers = new Set();
  const notify = () => {
    for (const changed of watchers) changed();
  };
  let generation = 0,
    grants = new Map(),
    me,
    latest,
    queued,
    tail = Promise.resolve();
  function commit(user, channels) {
    const next = new Map();
    for (const [id, channel] of channels) {
      const previous = grants.get(id);
      next.set(id, previous?.type === channel.type ? previous : { type: channel.type });
    }
    const changed =
      grants.size !== next.size || [...next].some(([id, grant]) => grants.get(id) !== grant);
    cache.directory.replace(user, channels);
    grants = next;
    me = user;
    if (changed) notify();
    const captured = new Map(next);
    const isCurrent = (id) => captured.has(id) && captured.get(id) === grants.get(id);
    return {
      me,
      channels,
      isCurrent,
      allowContent(id) {
        if (isCurrent(id) && captured.get(id).blocked) {
          captured.get(id).blocked = false;
          notify(); // Reopen a joined room when read permission is restored.
        }
      },
      denyContent(id) {
        if (!isCurrent(id)) return;
        cache.purgeChannel(id);
        // Invalidate all earlier content probes and historical writes for this room.
        grants.set(id, { type: channels.get(id).type, blocked: true });
      },
    };
  }
  async function load(readAccount, signal) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const version = generation;
      const user = readAccount || !me ? await account(session, signal) : me;
      const channels = await listAccessibleChannels(session, signal);
      signal.throwIfAborted();
      if (version !== generation) continue;
      const snapshot = commit(user, channels);
      latest = { token: randomUUID(), time: Date.now(), snapshot };
      return snapshot;
    }
    throw new Error("Directory changed during refresh; retry the lookup");
  }
  // Coalesce callers queued BEFORE network I/O. A later caller must not inherit
  // a possibly pre-revocation response, even when no socket event was delivered.
  async function refresh(signal, readAccount = true) {
    signal?.throwIfAborted();
    stop.signal.throwIfAborted();
    if (!queued || queued.control.signal.aborted) {
      const entry = { readAccount, control: new AbortController(), waiters: 0 };
      queued = entry;
      entry.promise = tail.then(() => {
        if (queued === entry) queued = undefined;
        const combined = AbortSignal.any([stop.signal, entry.control.signal]);
        combined.throwIfAborted();
        // One cancelled HTTP caller must not abort another caller's shared check.
        return withRequestSignal(undefined, () => load(entry.readAccount, combined));
      });
      tail = entry.promise.catch(() => {});
    } else if (readAccount) queued.readAccount = true;
    const entry = queued;
    entry.waiters++;
    let abort;
    try {
      if (!signal) return await entry.promise;
      const cancelled = new Promise((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      });
      return await Promise.race([entry.promise, cancelled]);
    } finally {
      if (abort) signal.removeEventListener("abort", abort);
      if (--entry.waiters === 0) entry.control.abort();
    }
  }
  return {
    refresh,
    watch(listener) {
      watchers.add(listener);
      return () => watchers.delete(listener);
    },
    // Continuations can share a short, identified snapshot while the stream is
    // healthy. Lost sockets, invalidations and subsequent refreshes end the lease.
    async page(filters, healthy, signal) {
      signal?.throwIfAborted();
      const { cursor, ...rest } = filters;
      const [id, token] = cursor?.split(".") ?? [];
      if (!token || !healthy() || token !== latest?.token || Date.now() - latest.time > 3000)
        await refresh(signal);
      const page = cache.directory.list({ ...rest, cursor: id });
      if (page.nextCursor && latest && healthy()) page.nextCursor += "." + latest.token;
      return page;
    },
    invalidate(revoked, metadataOnly = false) {
      generation++;
      latest = undefined;
      if (revoked) {
        grants.delete(revoked);
        cache.directory.remove(revoked);
      } else if (!metadataOnly) {
        grants = new Map();
      }
    },
    async close() {
      stop.abort();
      grants = new Map();
      latest = undefined;
      await tail;
    },
  };
}
