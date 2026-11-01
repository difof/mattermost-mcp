import { randomUUID } from "node:crypto";
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
  const db = cache.database;
  db.exec(`CREATE TABLE IF NOT EXISTS subscriptions(
    id TEXT PRIMARY KEY, target TEXT NOT NULL, filters TEXT NOT NULL, started INTEGER NOT NULL,
    expires INTEGER NOT NULL, cursor INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0,
    retry_at INTEGER NOT NULL DEFAULT 0, UNIQUE(target,filters))`);
  const sql = (s) => db.prepare(s);
  const clean = sql("DELETE FROM subscriptions WHERE expires<=?");
  const all = sql("SELECT * FROM subscriptions ORDER BY started,id");
  const get = sql("SELECT * FROM subscriptions WHERE id=?");
  const find = sql("SELECT id FROM subscriptions WHERE target=? AND filters=?");
  const due = sql(
    "SELECT * FROM subscriptions WHERE expires>? AND retry_at<=? ORDER BY retry_at,started,id",
  );
  const advance = sql("UPDATE subscriptions SET cursor=?, failures=0,retry_at=0 WHERE id=?");
  const fail = sql("UPDATE subscriptions SET failures=failures+1,retry_at=? WHERE id=?");
  const publicLease = (r) => ({
    subscriptionId: r.id,
    callbackUrl: r.target,
    filters: JSON.parse(r.filters),
    startedAt: r.started,
    expiresAt: r.expires,
    ...(r.failures ? { deliveryFailures: r.failures, retryAt: r.retry_at } : {}),
  });
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
  async function dispatch(row, item) {
    const lease = get.get(row.id),
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
      advance.run(item.seq, row.id);
      dirty = true;
    } catch {
      if (!control.signal.aborted && !stopSignal.signal.aborted) {
        fail.run(now() + Math.min(60000, 1000 * 2 ** Math.min(6, row.failures)), row.id);
        if (!row.failures) log("Message callback pending; retrying until its subscription expires");
      }
    } finally {
      flights.delete(row.id);
    }
  }
  async function tick() {
    clean.run(now());
    const hi = cache.highWatermark(),
      pending = [];
    for (const row of due.all(now(), now())) {
      if (row.cursor >= hi) continue;
      const item = cache.nextMatching(JSON.parse(row.filters), row.cursor, row.started);
      if (item) pending.push(row);
      else advance.run(hi, row.id);
    }
    if (!pending.length) return;
    // Revalidate membership before disclosing even IDs. A failed check keeps all cursors.
    await authorize(stopSignal.signal);
    let i = 0;
    await Promise.all(
      Array.from({ length: Math.min(pending.length, 4) }, async () => {
        while (i < pending.length && !stopSignal.signal.aborted) {
          const row = pending[i++],
            item = cache.nextMatching(JSON.parse(row.filters), row.cursor, row.started);
          if (item) await dispatch(row, item);
          else advance.run(hi, row.id);
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
    prune: () => clean.run(now()),
    // A removed destination must not receive a backlog if a later reload re-adds it.
    revokeDisabledTargets() {
      const remove = sql("DELETE FROM subscriptions WHERE id=?");
      for (const row of all.all()) {
        try {
          targets.resolve({ callback_url: row.target });
        } catch {
          remove.run(row.id);
        }
      }
    },
    register(args, filters) {
      const target = targets.resolve(args);
      const t = now(),
        expires = t + args.ttl_seconds * 1000;
      clean.run(t);
      const key = JSON.stringify(filters, Object.keys(filters).sort());
      let id = find.get(target.url, key)?.id;
      if (id) sql("UPDATE subscriptions SET expires=? WHERE id=?").run(expires, id);
      else {
        if (all.all().length >= 64)
          throw new Error("Maximum active message subscriptions reached (64)");
        id = randomUUID();
        sql(
          "INSERT INTO subscriptions(id,target,filters,started,expires,cursor) VALUES(?,?,?,?,?,?)",
        ).run(id, target.url, key, t, expires, cache.highWatermark());
      }
      wake();
      return publicLease(get.get(id));
    },
    list() {
      clean.run(now());
      return all.all().map(publicLease);
    },
    unsubscribe(id) {
      flights.get(id)?.abort();
      return { removed: sql("DELETE FROM subscriptions WHERE id=?").run(id).changes > 0 };
    },
    async stop() {
      stopSignal.abort();
      clearInterval(poll);
      clearTimeout(timer);
      await active;
    },
  };
}
