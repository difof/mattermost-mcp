import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { isMattermostId } from "./filter.js";

export const RETENTION_MS = 48 * 60 * 60 * 1000;
const PAGE_BYTES = 128 * 1024;
const validTime = (n) => Number.isSafeInteger(n) && n >= 0;

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

function readCursor(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value))
    throw new Error("Invalid message cache cursor");
  try {
    const tuple = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      Array.isArray(tuple) &&
      tuple.length === 2 &&
      validTime(tuple[0]) &&
      isMattermostId(tuple[1])
    )
      return tuple;
  } catch {
    /* malformed input */
  }
  throw new Error("Invalid message cache cursor");
}

function toCursor({ createdAt, postId }) {
  return Buffer.from(JSON.stringify([createdAt, postId])).toString("base64url");
}

function contentRow({ seq: _seq, ...row }) {
  const msg = { ...row, isMention: !!row.isMention, fileIds: JSON.parse(row.fileIds) };
  if (msg.fileIds.length > 100) {
    msg.fileCount = msg.fileIds.length;
    msg.fileIds = msg.fileIds.slice(0, 100);
  }
  // Account for JSON escaping (e.g. control characters), not just JS string length.
  const size = () => Buffer.byteLength(JSON.stringify(msg));
  if (size() > PAGE_BYTES - 256) {
    const original = msg.message;
    msg.messageTruncated = true;
    msg.messageBytes = Buffer.byteLength(original);
    let low = 0,
      high = Math.min(original.length, PAGE_BYTES);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      msg.message = original.slice(0, middle);
      if (size() <= PAGE_BYTES - 256) low = middle;
      else high = middle - 1;
    }
    if (low && /[\uD800-\uDBFF]/.test(original[low - 1])) low--;
    msg.message = original.slice(0, low);
  }
  return msg;
}

function conditions({ direction, channelId, senderId, channelType, isMention, since }, cutoff) {
  const where = ["message IS NOT NULL", "createdAt > ?"],
    args = [cutoff];
  for (const [field, value] of Object.entries({
    direction,
    channelId,
    senderId,
    channelType,
    isMention: isMention === undefined ? undefined : Number(isMention),
  })) {
    if (value === undefined) continue;
    where.push(field + " = ?");
    args.push(value);
  }
  if (since !== undefined) {
    if (!validTime(since)) throw new Error("Invalid message cache since timestamp");
    where.push("createdAt >= ?");
    args.push(since);
  }
  return { where, args };
}

function listMessages(db, options, cutoff) {
  const { cursor, limit = 25 } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Message cache limit must be 1 to 100");
  const { where, args } = conditions(options, cutoff);
  if (cursor !== undefined) {
    where.push("(createdAt, postId) < (?, ?)");
    args.push(...readCursor(cursor));
  }
  const query = db.prepare(
    "SELECT * FROM posts WHERE " +
      where.join(" AND ") +
      " ORDER BY createdAt DESC, postId DESC LIMIT ?",
  );
  const messages = [];
  let used = 160,
    nextCursor = null;
  for (const row of query.iterate(...args, limit + 1)) {
    if (messages.length === limit) {
      nextCursor = toCursor(messages.at(-1));
      break;
    }
    const msg = contentRow(row),
      bytes = Buffer.byteLength(JSON.stringify(msg)) + 1;
    if (messages.length && used + bytes > PAGE_BYTES) {
      nextCursor = toCursor(messages.at(-1));
      break;
    }
    messages.push(msg);
    used += bytes;
  }
  return { messages, nextCursor };
}

/** One synchronous SQLite connection per service; scope the filename to server, account and access policy. */
export async function openCache(file, { now = Date.now } = {}) {
  const DatabaseSync = process.getBuiltinModule?.("node:sqlite")?.DatabaseSync;
  if (!DatabaseSync)
    throw new Error("The SQLite message cache requires Node.js 22.13+ with node:sqlite");
  privateFile(file);
  const db = new DatabaseSync(file);
  try {
    createSchema(db);
    return cacheOperations(db, now);
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

const CLEAR =
  "senderId=NULL, rootId=NULL, channelType=NULL, direction=NULL, isMention=NULL, message=NULL, fileIds=NULL";

function postWriter(db) {
  const prior = db.prepare(
    "SELECT updatedAt, message IS NULL AS deleted FROM posts WHERE postId=?",
  );
  const insert = db.prepare(
    "INSERT INTO posts(postId,channelId,createdAt,updatedAt,senderId,rootId,channelType,direction,isMention,message,fileIds) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  );
  const update =
    db.prepare(`UPDATE posts SET updatedAt=?, senderId=?, rootId=?, channelType=?, direction=?, isMention=?, message=?, fileIds=?
      WHERE postId=? AND channelId=? AND message IS NOT NULL AND updatedAt < ?`);

  const tombstone =
    db.prepare(`INSERT INTO posts(postId,channelId,createdAt,updatedAt) VALUES(?,?,?,?)
      ON CONFLICT(postId) DO UPDATE SET updatedAt=max(posts.updatedAt,excluded.updatedAt), ${CLEAR}
      WHERE posts.channelId=excluded.channelId`);
  const clearReplies = db.prepare(
    `UPDATE posts SET ${CLEAR},updatedAt=? WHERE channelId=? AND rootId=? AND message IS NOT NULL AND postId!=?`,
  );
  return function write(record, cutoff) {
    const { postId, channelId, createdAt, updatedAt } = record;
    if (
      !isMattermostId(postId) ||
      !isMattermostId(channelId) ||
      !validTime(createdAt) ||
      !validTime(updatedAt)
    )
      throw new Error("Invalid message cache record");
    const stored = prior.get(postId);
    if (record.deleted) {
      // Mattermost emits just the root deletion when it also deletes every reply.
      // A root can predate retention even though its replies were posted today.
      const observedAt = cutoff + RETENTION_MS;
      clearReplies.run(observedAt, channelId, postId, postId);
      if (!stored?.deleted) tombstone.run(postId, channelId, createdAt, observedAt);
      return false;
    }
    if (createdAt <= cutoff || stored?.deleted || (stored && stored.updatedAt >= updatedAt))
      return false;
    const {
      senderId,
      rootId,
      channelType,
      direction,
      message,
      fileIds = [],
      isMention = false,
    } = record;
    if (
      !isMattermostId(senderId) ||
      !isMattermostId(rootId) ||
      !["D", "G", "O", "P"].includes(channelType) ||
      !["incoming", "outgoing"].includes(direction) ||
      typeof message !== "string" ||
      !Array.isArray(fileIds) ||
      !fileIds.every(isMattermostId)
    )
      throw new Error("Invalid message cache content");
    if (rootId !== postId && prior.get(rootId)?.deleted) return false;
    const values = [
      senderId,
      rootId,
      channelType,
      direction,
      Number(!!isMention),
      message,
      JSON.stringify(fileIds),
    ];
    if (!stored) {
      insert.run(postId, channelId, createdAt, updatedAt, ...values);
      return true;
    }
    update.run(updatedAt, ...values, postId, channelId, updatedAt);
    return false;
  };
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

function cacheOperations(db, now) {
  const write = postWriter(db);
  const expire = db.prepare(
    "DELETE FROM posts WHERE (message IS NOT NULL AND createdAt<=?) OR (message IS NULL AND updatedAt<=?)",
  );
  const removeOld = (cutoff) => expire.run(cutoff, cutoff).changes;
  const prune = () => removeOld(now() - RETENTION_MS);
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
  prune();
  return {
    database: db,
    highWatermark: () => watermark.get()?.seq ?? 0,
    nextMatching(filters, afterSeq, sinceMs) {
      if (!validTime(afterSeq) || !validTime(sinceMs))
        throw new Error("Invalid subscription cursor");
      const { where, args } = conditions(
        { ...filters, since: Math.max(filters.since ?? 0, sinceMs) },
        now() - RETENTION_MS,
      );
      const row = db
        .prepare(
          "SELECT * FROM posts WHERE " + where.join(" AND ") + " AND seq > ? ORDER BY seq LIMIT 1",
        )
        .get(...args, afterSeq);
      return row ? { seq: row.seq, record: contentRow(row) } : null;
    },
    getCheckpoint: () => readTime.get()?.time ?? null,
    checkpoint(time) {
      if (!validTime(time)) throw new Error("Invalid cache checkpoint");
      setTime.run(time);
    },
    apply(record) {
      const cutoff = now() - RETENTION_MS;
      return transaction(db, () => {
        removeOld(cutoff);
        return write(record, cutoff);
      });
    },
    applyBatch(records) {
      const cutoff = now() - RETENTION_MS;
      return transaction(db, () => {
        removeOld(cutoff);
        return records.filter((record) => write(record, cutoff));
      });
    },
    list(options = {}) {
      const cutoff = now() - RETENTION_MS;
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
        .all(channelId, Math.max(since, now() - RETENTION_MS + 1), until)
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
