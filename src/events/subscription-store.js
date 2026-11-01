import { randomUUID } from "node:crypto";

function publicLease(row) {
  return {
    subscriptionId: row.id,
    callbackUrl: row.target,
    filters: JSON.parse(row.filters),
    startedAt: row.started,
    expiresAt: row.expires,
    ...(row.failures ? { deliveryFailures: row.failures, retryAt: row.retry_at } : {}),
  };
}

/** Durable leases contain delivery cursors and filters, never a second copy of a post. */
export function openLeaseStore(cache, now) {
  const db = cache.database;
  db.exec(`CREATE TABLE IF NOT EXISTS subscriptions(
    id TEXT PRIMARY KEY, target TEXT NOT NULL, filters TEXT NOT NULL, started INTEGER NOT NULL,
    expires INTEGER NOT NULL, cursor INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0,
    retry_at INTEGER NOT NULL DEFAULT 0, UNIQUE(target,filters))`);
  const clean = db.prepare("DELETE FROM subscriptions WHERE expires<=?");
  const all = db.prepare("SELECT * FROM subscriptions ORDER BY started,id");
  const get = db.prepare("SELECT * FROM subscriptions WHERE id=?");
  const find = db.prepare("SELECT id FROM subscriptions WHERE target=? AND filters=?");
  const due = db.prepare(
    "SELECT * FROM subscriptions WHERE expires>? AND retry_at<=? ORDER BY retry_at,started,id",
  );
  const advance = db.prepare("UPDATE subscriptions SET cursor=?, failures=0,retry_at=0 WHERE id=?");
  const fail = db.prepare("UPDATE subscriptions SET failures=failures+1,retry_at=? WHERE id=?");
  const remove = db.prepare("DELETE FROM subscriptions WHERE id=?");
  const renew = db.prepare("UPDATE subscriptions SET expires=? WHERE id=?");
  const count = db.prepare("SELECT count(*) AS n FROM subscriptions");
  const add = db.prepare(
    "INSERT INTO subscriptions(id,target,filters,started,expires,cursor) VALUES(?,?,?,?,?,?)",
  );
  const prune = () => clean.run(now());
  return {
    prune,
    due: (time) => due.all(time, time),
    get: (id) => get.get(id),
    advance: (id, cursor) => advance.run(cursor, id),
    retry: (id, time) => fail.run(time, id),
    remove: (id) => remove.run(id).changes > 0,
    list() {
      prune();
      return all.all().map(publicLease);
    },
    register(target, filters, seconds) {
      const started = now(),
        expires = started + seconds * 1000;
      clean.run(started);
      const key = JSON.stringify(filters, Object.keys(filters).sort());
      let id = find.get(target, key)?.id;
      if (id) renew.run(expires, id);
      else {
        if (count.get().n >= 64)
          throw new Error("Maximum active message subscriptions reached (64)");
        id = randomUUID();
        add.run(id, target, key, started, expires, cache.highWatermark());
      }
      return publicLease(get.get(id));
    },
  };
}
