// Only opaque identifiers leave the listener. A post body is never an instruction.
const mattermostId = /^[a-z0-9]{26}$/;
export const isMattermostId = (value) => typeof value === "string" && mattermostId.test(value);

function hasPersonalMention(message, username) {
  // Ignore code, link targets, URLs and email-like text. The live path additionally
  // requires Mattermost's per-recipient mention ID (which can also mean @channel).
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

export function selectPost(post, channelType, me, mentionIds) {
  if (
    !post ||
    !isMattermostId(post.id) ||
    !isMattermostId(post.channel_id) ||
    !isMattermostId(post.user_id) ||
    (post.root_id && !isMattermostId(post.root_id)) ||
    !Number.isSafeInteger(post.create_at) ||
    post.create_at <= 0 ||
    post.delete_at ||
    post.user_id === me.id ||
    post.type?.startsWith("system_")
  )
    return null;
  if (channelType !== "D") {
    if (mentionIds === undefined) {
      // REST does not retain the original at-post-time text of edited messages.
      if (post.edit_at) return null;
    } else if (!Array.isArray(mentionIds) || !mentionIds.includes(me.id)) return null;
    if (
      !["O", "P", "G"].includes(channelType) ||
      !me.username ||
      typeof post.message !== "string" ||
      !hasPersonalMention(post.message, me.username)
    )
      return null;
  }
  return {
    kind: channelType === "D" ? "dm" : "mention",
    postId: post.id,
    channelId: post.channel_id,
    rootId: post.root_id || post.id,
    senderId: post.user_id,
    createdAt: post.create_at,
  };
}

// These WebSocket attributes are JSON strings in Mattermost v11.
export function selectPostedFrame(frame, me) {
  if (frame.event !== "posted") return null;
  const data = frame.data ?? {};
  const post = typeof data.post === "string" ? JSON.parse(data.post) : data.post;
  if (!post || (frame.broadcast?.channel_id && frame.broadcast.channel_id !== post.channel_id))
    return null;
  const ids = typeof data.mentions === "string" ? JSON.parse(data.mentions) : data.mentions;
  return selectPost(post, data.channel_type, me, ids ?? []);
}
