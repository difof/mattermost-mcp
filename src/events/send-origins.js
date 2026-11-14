import { randomBytes } from "node:crypto";
export function sendOrigins(db, now, retentionMs) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS send_intents(pending_id TEXT PRIMARY KEY,created INTEGER NOT NULL,post_id TEXT UNIQUE)",
  );
  const active = new Set();
  const find = db.prepare("SELECT pending_id FROM send_intents WHERE pending_id=?");
  const known = db.prepare("SELECT 1 FROM send_intents WHERE post_id=?");
  const complete = (pendingId, postId) =>
    db.prepare("UPDATE send_intents SET post_id=? WHERE pending_id=?").run(postId, pendingId);
  return {
    busy: () => active.size > 0,
    finish: (pendingId) => active.delete(pendingId),
    begin(pendingId) {
      active.add(pendingId);
      db.prepare("INSERT OR IGNORE INTO send_intents(pending_id,created) VALUES(?,?)").run(
        pendingId,
        now(),
      );
    },
    complete,
    observe(record) {
      if (record.direction === "outgoing" && record.pendingPostId && find.get(record.pendingPostId))
        complete(record.pendingPostId, record.postId);
    },
    known: (postId) => !!known.get(postId),
    prune: () => db.prepare("DELETE FROM send_intents WHERE created<=?").run(now() - retentionMs),
  };
}
export function trackedBody(session, body) {
  if (!session.cache?.sends) return body;
  const pendingId = body.pending_post_id || "mcp-" + randomBytes(32).toString("hex");
  session.cache?.sends.begin(pendingId);
  return { ...body, pending_post_id: pendingId };
}
export async function trackedPost(session, body) {
  const next = trackedBody(session, body);
  try {
    const post = await session.call((c) => c.createPost(next));
    session.cache?.sends.complete(next.pending_post_id, post.id);
    return post;
  } finally {
    session.cache?.sends.finish(next.pending_post_id);
  }
}
