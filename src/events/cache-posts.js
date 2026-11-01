import { isMattermostId } from "./filter.js";

export const validTime = (n) => Number.isSafeInteger(n) && n >= 0;

export const CLEAR =
  "senderId=NULL, rootId=NULL, channelType=NULL, direction=NULL, isMention=NULL, message=NULL, fileIds=NULL";

export function postWriter(db, retentionMs) {
  const prior = db.prepare(
    "SELECT updatedAt, verifiedView, message IS NULL AS deleted FROM posts WHERE postId=?",
  );
  const insert = db.prepare(
    "INSERT INTO posts(postId,channelId,createdAt,updatedAt,senderId,rootId,channelType,direction,isMention,message,fileIds) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  );
  const update =
    db.prepare(`UPDATE posts SET updatedAt=?, senderId=?, rootId=?, channelType=?, direction=?, isMention=?, message=?, fileIds=?, verifiedView=?
      WHERE postId=? AND channelId=? AND message IS NOT NULL AND updatedAt <= ?`);

  const tombstone =
    db.prepare(`INSERT INTO posts(postId,channelId,createdAt,updatedAt) VALUES(?,?,?,?)
      ON CONFLICT(postId) DO UPDATE SET updatedAt=max(posts.updatedAt,excluded.updatedAt), ${CLEAR}
      WHERE posts.channelId=excluded.channelId`);
  const clearReplies = db.prepare(
    `UPDATE posts SET ${CLEAR},updatedAt=? WHERE channelId=? AND rootId=? AND message IS NOT NULL AND postId!=?`,
  );
  return function write(record, cutoff, authoritative = false) {
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
      const observedAt = cutoff + retentionMs;
      clearReplies.run(observedAt, channelId, postId, postId);
      if (!stored?.deleted) tombstone.run(postId, channelId, createdAt, observedAt);
      return false;
    }
    if (
      createdAt <= cutoff ||
      stored?.deleted ||
      (stored &&
        (stored.updatedAt > updatedAt ||
          (stored.updatedAt === updatedAt &&
            (!authoritative || (stored.verifiedView && authoritative !== "single-post")))))
    )
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
    update.run(
      updatedAt,
      ...values,
      Number(authoritative === "single-post"),
      postId,
      channelId,
      updatedAt,
    );
    return false;
  };
}
