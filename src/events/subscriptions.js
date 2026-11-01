import { openLeaseStore } from "./subscription-store.js";
import { deliverCallback } from "./callbacks.js";
import { log } from "../log.js";

/** A lease advances through the cache, not a second copy of the message stream. */
export function createSubscriptions({
  cache,
  targets,
  account,
  authorize,
  now = Date.now,
  send = deliverCallback,
  deferred = false,
}) {
  const leases = openLeaseStore(cache, now);
  const flights = new Map();
  const stopSignal = new AbortController();
  let timer,
    active,
    dirty = false;
  function wake() {
    dirty = true;
    if (!poll || timer || active || stopSignal.signal.aborted) return;
    timer = setTimeout(() => {
      timer = undefined;
      dirty = false;
      active = tick()
        .catch(() => log("Message subscription processing delayed"))
        .finally(() => {
          active = undefined;
          if (dirty) wake();
        });
    }, 15);
    timer.unref();
  }
  function retry(row) {
    if (stopSignal.signal.aborted) return;
    leases.retry(row.id, now() + Math.min(60000, 1000 * 2 ** Math.min(6, row.failures)));
    if (!row.failures) log("Message callback pending; retrying until its subscription expires");
  }
  async function dispatch(row, item) {
    const lease = leases.get(row.id),
      currentTime = now();
    if (!lease || lease.expires <= currentTime) return;
    const control = new AbortController();
    flights.set(row.id, control);
    const signal = AbortSignal.any([
      stopSignal.signal,
      control.signal,
      AbortSignal.timeout(Math.max(1, Math.min(10000, lease.expires - currentTime))),
    ]);
    try {
      await send(
        targets.resolve({ callback_url: row.target }),
        row.id,
        account,
        item.record,
        signal,
      );
      leases.advance(row.id, item.seq);
      dirty = true;
    } catch {
      if (!control.signal.aborted) retry(row);
    } finally {
      flights.delete(row.id);
    }
  }
  async function tick() {
    leases.prune();
    const hi = cache.highWatermark(),
      pending = [];
    for (const row of leases.due(now())) {
      if (row.cursor >= hi) continue;
      const item = cache.nextMatching(JSON.parse(row.filters), row.cursor, row.started);
      if (item) pending.push({ row, item });
      else leases.advance(row.id, hi);
    }
    if (!pending.length) return;
    // Check read permission only for channels about to be disclosed.
    let decision;
    try {
      decision = await authorize(
        pending.map(({ item }) => item.record.channelId),
        stopSignal.signal,
        pending.map(({ item }) => item.record),
      );
    } catch {
      // No verified membership snapshot: retry without advancing any lease.
      for (const { row } of pending) retry(row);
      return;
    }
    let i = 0;
    await Promise.all(
      Array.from({ length: Math.min(pending.length, 4) }, async () => {
        while (i < pending.length && !stopSignal.signal.aborted) {
          const { row, item } = pending[i++];
          const fresh = cache.nextMatching(JSON.parse(row.filters), row.cursor, row.started);
          if (!fresh) leases.advance(row.id, hi);
          else if (fresh.seq === item.seq) {
            const allowed = decision(fresh.record.channelId, fresh.record);
            if (allowed === true) await dispatch(row, fresh);
            else if (allowed === undefined) retry(row);
          }
          // A changed candidate needs its own authorization on the next tick.
        }
      }),
    );
  }
  let poll;
  function start() {
    if (poll || stopSignal.signal.aborted) return;
    poll = setInterval(wake, 1000);
    poll.unref();
    wake();
  }
  if (!deferred) start();
  return {
    start,
    wake,
    prune: leases.prune,
    list: leases.list,
    // A removed destination must not receive a backlog if a later reload re-adds it.
    revokeDisabledTargets() {
      for (const lease of leases.list()) {
        try {
          targets.resolve({ callback_url: lease.callbackUrl });
        } catch {
          leases.remove(lease.subscriptionId);
        }
      }
    },
    register(args, filters) {
      const target = targets.resolve(args);
      const lease = leases.register(target.url, filters, args.ttl_seconds);
      wake();
      return lease;
    },
    unsubscribe(id) {
      flights.get(id)?.abort();
      return { removed: leases.remove(id) };
    },
    async stop() {
      stopSignal.abort();
      clearInterval(poll);
      clearTimeout(timer);
      await active;
    },
  };
}
