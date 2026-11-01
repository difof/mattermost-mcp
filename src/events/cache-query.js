import { isMattermostId } from "./filter.js";
import { validTime } from "./cache-posts.js";

const PAGE_BYTES = 128 * 1024;

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

export function listMessages(db, options, cutoff, delivering = false) {
  const { cursor, limit = 25 } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Message cache limit must be 1 to 100");
  const { where, args } = conditions(options, cutoff);
  if (options.unreadOnly) where.push("readCount=0");
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
    // Size the exact response, including the post-delivery counter. Omitted
    // rows (limit, byte budget, or cursor) never count as delivered.
    if (delivering) row.readCount++;
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

export function nextMatching(db, filters, afterSeq, sinceMs, cutoff) {
  if (!validTime(afterSeq) || !validTime(sinceMs)) throw new Error("Invalid subscription cursor");
  const { where, args } = conditions(
    { ...filters, since: Math.max(filters.since ?? 0, sinceMs) },
    cutoff,
  );
  const row = db
    .prepare(
      "SELECT * FROM posts WHERE " + where.join(" AND ") + " AND seq > ? ORDER BY seq LIMIT 1",
    )
    .get(...args, afterSeq);
  return row ? { seq: row.seq, record: contentRow(row) } : null;
}
