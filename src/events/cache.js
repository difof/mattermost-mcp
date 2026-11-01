import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { listMessages, nextMatching } from "./cache-query.js";
import { CLEAR, postWriter, validTime } from "./cache-posts.js";

export const DEFAULT_RETENTION_HOURS = 48;
export const RETENTION_MS = DEFAULT_RETENTION_HOURS * 3600000;
function retentionWindow(hours) {
  if (!Number.isInteger(hours) || hours < 1 || hours > 168)
    throw new Error("Cache retention must be an integer between 1 and 168 hours");
  return hours * 3600000;
}

/** SQLite opens by path; ensure the containing directory and the pre-created file are private. */
function privateFile(file) {
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const owned = (st) =>
    process.platform === "win32" || (st.uid === process.getuid() && !(st.mode & 0o077));
  const dir = lstatSync(directory);
  if (!dir.isDirectory() || !owned(dir))
    throw new Error("Use an owner-only message cache directory (0700)");
  const fd = openSync(
    file,
    constants.O_CREAT |
      constants.O_RDWR |
      (constants.O_NOFOLLOW || 0) |
      (constants.O_NONBLOCK || 0),
    0o600,
  );
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || !owned(st))
      throw new Error("Use an owner-only regular message cache file (0600)");
  } finally {
    closeSync(fd);
  }
}

/** One synchronous SQLite connection per service; scope the filename to server, account and access policy. */
export async function openCache(
  file,
  { now = Date.now, retentionHours = DEFAULT_RETENTION_HOURS, deferPrune = false } = {},
) {
  const retentionMs = retentionWindow(retentionHours);
  const DatabaseSync = process.getBuiltinModule?.("node:sqlite")?.DatabaseSync;
  if (!DatabaseSync)
    throw new Error("The SQLite message cache requires Node.js 22.13+ with node:sqlite");
  privateFile(file);
  const db = new DatabaseSync(file);
  try {
    createSchema(db);
    return cacheOperations(db, now, retentionMs, deferPrune);
  } catch (error) {
    db.close();
    throw error;
  }
}

function createSchema(db) {
  db.exec(`
      PRAGMA journal_mode=DELETE;
      PRAGMA secure_delete=ON;
      PRAGMA temp_store=MEMORY;
      PRAGMA trusted_schema=OFF;
      PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS posts (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, postId TEXT NOT NULL UNIQUE, channelId TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        senderId TEXT, rootId TEXT, channelType TEXT, direction TEXT, isMention INTEGER, message TEXT, fileIds TEXT
      );
      CREATE INDEX IF NOT EXISTS timeline ON posts(createdAt DESC, postId DESC);
      CREATE INDEX IF NOT EXISTS channel_timeline ON posts(channelId, createdAt DESC, postId DESC);
      CREATE INDEX IF NOT EXISTS thread_replies ON posts(channelId,rootId) WHERE rootId IS NOT NULL;
      CREATE INDEX IF NOT EXISTS tombstone_age ON posts(updatedAt) WHERE message IS NULL;
      CREATE TABLE IF NOT EXISTS checkpoint (id INTEGER PRIMARY KEY CHECK(id=1), time INTEGER NOT NULL);
    `);
}

function transaction(db, run) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function cacheOperations(db, now, retentionMs, deferPrune) {
  const write = postWriter(db, retentionMs);
  const expire = db.prepare(
    "DELETE FROM posts WHERE (message IS NOT NULL AND createdAt<=?) OR (message IS NULL AND updatedAt<=?)",
  );
  const removeOld = (cutoff) => expire.run(cutoff, cutoff).changes;
  const prune = () => removeOld(now() - retentionMs);
  const readTime = db.prepare("SELECT time FROM checkpoint WHERE id=1");
  const setTime = db.prepare(
    "INSERT INTO checkpoint VALUES(1,?) ON CONFLICT(id) DO UPDATE SET time=excluded.time WHERE time<excluded.time",
  );
  const purge = db.prepare("DELETE FROM posts WHERE channelId=?");
  const retain = db.prepare(
    "DELETE FROM posts WHERE channelId NOT IN (SELECT value FROM json_each(?))",
  );
  const ids = db.prepare(
    "SELECT postId FROM posts WHERE channelId=? AND message IS NOT NULL AND createdAt BETWEEN ? AND ?",
  );
  const missing =
    db.prepare(`UPDATE posts SET ${CLEAR},updatedAt=? WHERE channelId=? AND updatedAt<=?
      AND message IS NOT NULL AND (postId IN (SELECT value FROM json_each(?)) OR rootId IN (SELECT value FROM json_each(?)))`);
  const watermark = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='posts'");
  if (!deferPrune) prune();
  return {
    database: db,
    retentionMs,
    transaction: (operation) => transaction(db, operation),
    highWatermark: () => watermark.get()?.seq ?? 0,
    nextMatching: (filters, afterSeq, sinceMs) =>
      nextMatching(db, filters, afterSeq, sinceMs, now() - retentionMs),
    getCheckpoint: () => readTime.get()?.time ?? null,
    checkpoint(time) {
      if (!validTime(time)) throw new Error("Invalid cache checkpoint");
      setTime.run(time);
    },
    apply(record) {
      const cutoff = now() - retentionMs;
      return transaction(db, () => {
        removeOld(cutoff);
        return write(record, cutoff);
      });
    },
    applyBatch(records) {
      const cutoff = now() - retentionMs;
      return transaction(db, () => {
        removeOld(cutoff);
        return records.filter((record) => write(record, cutoff));
      });
    },
    list(options = {}) {
      const cutoff = now() - retentionMs;
      removeOld(cutoff);
      return listMessages(db, options, cutoff);
    },
    purgeChannel(channelId) {
      purge.run(channelId);
    },
    retainChannels(allowed) {
      retain.run(JSON.stringify([...allowed]));
    },
    cachedIds(channelId, since, until) {
      return ids
        .all(channelId, Math.max(since, now() - retentionMs + 1), until)
        .map((r) => r.postId);
    },
    reconcileMissing(channelId, removed, until) {
      const keys = JSON.stringify([...removed]);
      missing.run(until, channelId, until, keys, keys);
    },
    prune,
    close: () => db.close(),
  };
}
