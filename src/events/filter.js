const mattermostId = /^[a-z0-9]{26}$/;
export const isMattermostId = (value) => typeof value === "string" && mattermostId.test(value);

function hasPersonalMention(message, username) {
  // Count an explicit personal handle, excluding code, link targets, URLs and email-like text.
  if (!/[@＠]/.test(message)) return false;
  const prose = message
    .replace(/^ {0,3}`{3,}[^\n]*\n[\s\S]*?(?:^ {0,3}`{3,}[^\n]*$|(?![\s\S]))/gm, " ")
    .replace(/^ {0,3}~{3,}[^\n]*\n[\s\S]*?(?:^ {0,3}~{3,}[^\n]*$|(?![\s\S]))/gm, " ")
    .replace(/(`+)[\s\S]*?\1/g, " ")
    .replace(/\]\([^\n)]*\)|https?:\/\/[^\s<>]+/gi, " ");
  const handle = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?<![\\p{L}\\p{N}_@＠/\\\\])[@＠]${handle}(?![a-z0-9_-]|\\.[a-z0-9_-])`,
    "iu",
  ).test(prose);
}

export const allowedChannelTypes = new Set(["D", "G", "O", "P"]);

// Keep only the fields needed for a cached message. In particular, props, embed previews,
// file bodies, and private integration payloads never reach the store.
export function selectPost(post, channelType, me, deleted = false) {
  if (
    !post ||
    !isMattermostId(post.id) ||
    !isMattermostId(post.channel_id) ||
    !Number.isSafeInteger(post.create_at) ||
    post.create_at <= 0 ||
    post.type === "burn_on_read" ||
    (post.type != null && (typeof post.type !== "string" || post.type.startsWith("system_")))
  ) {
    return null;
  }
  const times = [post.update_at, post.edit_at, post.delete_at].filter(Number.isSafeInteger);
  const base = {
    postId: post.id,
    channelId: post.channel_id,
    createdAt: post.create_at,
    updatedAt: Math.max(post.create_at, ...times),
  };
  if (deleted || post.delete_at > 0) {
    // Mattermost can publish post_deleted with the pre-deletion post object. Its edit
    // timestamp is not the delete time; retain a current tombstone for this event.
    if (deleted && !(post.delete_at > 0)) base.updatedAt = Math.max(base.updatedAt, Date.now());
    return { ...base, deleted: true };
  }
  if (!isMattermostId(post.user_id) || (post.root_id && !isMattermostId(post.root_id))) return null;
  const message = typeof post.message === "string" ? post.message : "";
  return {
    ...base,
    senderId: post.user_id,
    rootId: post.root_id || post.id,
    channelType,
    direction: post.user_id === me.id ? "outgoing" : "incoming",
    message,
    fileIds: Array.isArray(post.file_ids) ? [...new Set(post.file_ids.filter(isMattermostId))] : [],
    isMention: Boolean(me.username && hasPersonalMention(message, me.username)),
  };
}

export function selectPostedFrame(frame, me) {
  if (!["posted", "post_edited", "post_deleted"].includes(frame.event)) return null;
  const data = frame.data ?? {};
  const post = typeof data.post === "string" ? JSON.parse(data.post) : data.post;
  if (!post || (frame.broadcast?.channel_id && frame.broadcast.channel_id !== post.channel_id))
    return null;
  // Edit/delete frames need not include channel_type. The consumer resolves it against
  // the authenticated membership catalog before applying the record.
  return selectPost(post, data.channel_type, me, frame.event === "post_deleted");
}
