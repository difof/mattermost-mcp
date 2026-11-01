import { createHash } from "node:crypto";
import { contentRow, fitMessage, PAGE_BYTES } from "./cache-query.js";

const receiptTtlMs = 10 * 60_000;
const maxReceipts = 1024;
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// A replay may combine many edited rows. A per-row cap alone is insufficient
// when short original rows have all grown and another row already filled the page.
function fitReplay(messages) {
  const bytes = (message) => Buffer.byteLength(JSON.stringify(message));
  const sizes = messages.map((message) => ({ message, size: bytes(message) }));
  let excess = sizes.reduce((n, { size }) => n + size + 1, 256) - PAGE_BYTES;
  if (excess <= 0) return;
  for (const { message, size } of sizes.sort((a, b) => b.size - a.size)) {
    if (size <= 768) continue;
    fitMessage(message, Math.max(768, size - excess));
    excess -= size - bytes(message);
    if (excess <= 0) return;
  }
  throw new Error("Inbox retry page exceeds the response budget");
}

// Only IDs, sequence numbers and sizes survive a retry. Never persist a second copy of a post.
export function receiptKey(requestId, caller, filters) {
  if (!requestId) return undefined;
  const { excludedChannels: _authorization, ...selection } = filters;
  return { key: hash([caller ?? null, requestId]), signature: hash(selection) };
}

export function inboxOperations(db, { transaction, list, now, retentionMs }) {
  db.exec(`CREATE TABLE IF NOT EXISTS inbox_receipts (
    key TEXT PRIMARY KEY, signature TEXT NOT NULL, expires INTEGER NOT NULL,
    entries TEXT NOT NULL, more INTEGER NOT NULL) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS inbox_receipts_expiry ON inbox_receipts(expires);`);
  const find = db.prepare("SELECT * FROM inbox_receipts WHERE key=?");
  const expire = db.prepare("DELETE FROM inbox_receipts WHERE expires<=?");
  const size = db.prepare("SELECT count(*) AS count FROM inbox_receipts");
  const save = db.prepare("INSERT INTO inbox_receipts VALUES (?,?,?,?,?)");
  const sequence = db.prepare("SELECT seq FROM posts WHERE postId=?");
  const previous = db.prepare(
    "SELECT * FROM posts WHERE seq=? AND message IS NOT NULL AND createdAt>?",
  );
  const increment = db.prepare(
    "UPDATE posts SET readCount=readCount+1 WHERE postId IN (SELECT value FROM json_each(?))",
  );
  const distinct = db.prepare(
    "SELECT DISTINCT channelId FROM posts WHERE message IS NOT NULL AND createdAt>?",
  );
  const counts =
    db.prepare(`SELECT count(*) AS retained, count(*) FILTER (WHERE readCount=0) AS unread
    FROM posts WHERE message IS NOT NULL AND createdAt>? AND channelId IN (SELECT value FROM json_each(?))`);

  function replay(saved, options, allows, posts) {
    const messages = [],
      unverified = new Set();
    const cutoff = now() - retentionMs;
    const entries = JSON.parse(saved.entries);
    let last;
    for (const [seq, count, bytes] of entries) {
      const row = previous.get(seq, cutoff);
      if (!row || options.excludedChannels?.has(row.channelId)) continue;
      if (!allows(row.channelId)) {
        unverified.add(row.channelId);
        continue;
      }
      row.readCount = count; // Count at the original issuance, not after later callers.
      messages.push(contentRow(row, bytes));
      if (seq === entries.at(-1)[0]) last = row;
    }
    if (unverified.size) return { unverified: [...unverified] };
    const unverifiedPosts = posts?.missing(messages);
    if (unverifiedPosts?.length) return { unverifiedPosts };
    fitReplay(messages);
    // A cursor contains a post ID; never return it for a now-invisible or expired row.
    const nextCursor =
      saved.more && last
        ? Buffer.from(JSON.stringify([last.createdAt, last.postId])).toString("base64url")
        : null;
    return {
      page: {
        messages,
        nextCursor,
        replayed: true,
        ...(saved.more && !last ? { cursorInvalidated: true } : {}),
      },
    };
  }

  function claim(options, allows, receipt, posts) {
    if (receipt) {
      expire.run(now());
      const saved = find.get(receipt.key);
      if (saved) {
        if (saved.signature !== receipt.signature)
          throw new Error("request_id was already used with different inbox arguments");
        return replay(saved, options, allows, posts);
      }
      if (size.get().count >= maxReceipts)
        throw new Error("Inbox retry receipt limit reached; retry later");
    }
    const page = list(options, true);
    const unverified = [...new Set(page.messages.map((row) => row.channelId))].filter(
      (id) => !allows(id),
    );
    if (unverified.length) return { unverified };
    const unverifiedPosts = posts?.missing(page.messages);
    if (unverifiedPosts?.length) return { unverifiedPosts };
    if (page.messages.length) increment.run(JSON.stringify(page.messages.map((row) => row.postId)));
    if (receipt) {
      const entries = page.messages.map((row) => [
        sequence.get(row.postId).seq,
        row.readCount,
        Math.max(768, Buffer.byteLength(JSON.stringify(row))),
      ]);
      save.run(
        receipt.key,
        receipt.signature,
        now() + receiptTtlMs,
        JSON.stringify(entries),
        Number(!!page.nextCursor),
      );
    }
    return { page };
  }
  return {
    pullPage: (options, allows, receipt, posts) =>
      transaction(() => claim(options, allows, receipt, posts)),
    pruneReceipts: () => expire.run(now()),
    inboxChannels: () => distinct.all(now() - retentionMs).map((row) => row.channelId),
    inboxCounts: (ids) => ({ ...counts.get(now() - retentionMs, JSON.stringify(ids)) }),
  };
}
