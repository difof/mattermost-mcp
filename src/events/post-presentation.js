// Returned snapshots are private, call-local proofs. Never use readCount as a
// presentation version: another agent reading the same post doesn't change it.
import { isDeepStrictEqual } from "node:util";
import { readEventJson } from "./api.js";
import { selectPost } from "./filter.js";

export function presentationStore(db, transaction, write, cutoff) {
  const row = db.prepare(`SELECT seq,postId,channelId,createdAt,updatedAt,
    senderId,rootId,channelType,direction,isMention,message,fileIds
    FROM posts WHERE postId=? AND message IS NOT NULL AND createdAt>?`);
  const remove = db.prepare("DELETE FROM posts WHERE seq=?");
  const snapshot = (id) => row.get(id, cutoff());
  return {
    snapshot,
    // Never restore a purged post, or overwrite a newer equal-time rendering.
    // Include the insertion sequence in equality to distinguish a leave/rejoin.
    settle(before, record, allows) {
      return transaction(() => {
        if (!allows(before.channelId) || !isDeepStrictEqual(before, snapshot(before.postId)))
          return;
        if (!record) {
          remove.run(before.seq);
          return;
        }
        if (record.createdAt !== before.createdAt || record.updatedAt < before.updatedAt)
          throw new Error("Post changed during verification; retry the pull");
        write(record, cutoff(), "single-post");
        const after = snapshot(before.postId);
        if (
          !after ||
          after.seq !== before.seq ||
          after.message !== record.message ||
          after.updatedAt !== record.updatedAt ||
          after.senderId !== record.senderId ||
          after.rootId !== record.rootId ||
          after.fileIds !== JSON.stringify(record.fileIds) ||
          Boolean(after.isMention) !== record.isMention ||
          after.direction !== record.direction ||
          after.channelType !== record.channelType
        )
          return;
        return after;
      });
    },
  };
}

// Channel permission alone may not reflect how a plugin presents individual
// posts. Strict callers authorize precisely the rows about to be disclosed.
export function postAccess(session, cache, access, signal = new AbortController().signal) {
  if (!session.config.cacheVerifyPosts) return;
  const verified = new Map(),
    store = cache.presentation;
  function allows({ postId, channelId }) {
    return (
      access.allows(channelId) &&
      verified.has(postId) &&
      isDeepStrictEqual(verified.get(postId), store.snapshot(postId))
    );
  }
  function missing(rows) {
    return rows
      .filter((row) => !allows(row))
      .map(({ postId, channelId }) => ({ postId, channelId }));
  }
  async function verify({ postId, channelId }) {
    signal.throwIfAborted();
    const before = store.snapshot(postId);
    if (!before || before.channelId !== channelId || !access.allows(channelId)) return;
    let post;
    try {
      post = await readEventJson(session, session.client.getPostRoute(postId), signal);
    } catch (error) {
      if (![403, 404].includes(error?.status_code))
        throw new Error("Could not verify Mattermost post visibility");
    }
    signal.throwIfAborted();
    if (post !== undefined && (post?.id !== postId || post.channel_id !== channelId))
      throw new Error("Unexpected post in visibility response");
    const record = post ? selectPost(post, before.channelType, access.me) : null;
    const after = store.settle(before, record?.deleted ? null : record, access.allows);
    if (after) verified.set(postId, after);
  }
  return {
    allows,
    missing,
    async check(rows, { partial = false } = {}) {
      const unique = [...new Map(rows.map((row) => [row.postId, row])).values()];
      for (let i = 0; i < unique.length; i += 4) {
        const results = await Promise.allSettled(unique.slice(i, i + 4).map(verify));
        signal.throwIfAborted();
        const failure = results.find((r) => r.status === "rejected");
        if (failure && !partial) throw failure.reason;
      }
    },
  };
}
