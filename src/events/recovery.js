import { ResourceGuard } from "../resource-guardrails.js";
import { isMattermostId, selectPost } from "./filter.js";
import { readEventJson } from "./api.js";

const pageSize = 60;

async function replayChannel({ session, channel, since, until, me, enqueue, signal }) {
  const url = new URL(session.client.getChannelRoute(channel.id) + "/posts");
  url.searchParams.set("per_page", String(pageSize));
  url.searchParams.set("skipFetchThreads", "true");
  // Fetch newer posts first using an exclusive ID cursor; page offsets shift on a busy
  // channel. No silent page cap: stream one bounded page at a time down to the watermark.
  let previousTime = Infinity;
  const tiedCursors = new Set();
  for (;;) {
    signal.throwIfAborted();
    const list = await readEventJson(session, url, signal);
    if (!Array.isArray(list.order) || !list.posts) throw new Error("Invalid post list");
    if (!list.order.length) return;
    let oldest = Infinity;
    for (const id of list.order) {
      const post = list.posts[id];
      if (!post || post.channel_id !== channel.id || !Number.isSafeInteger(post.create_at)) {
        throw new Error("Invalid post in channel history");
      }
      oldest = Math.min(oldest, post.create_at);
      if (post.create_at < since || post.create_at > until) continue;
      const event = selectPost(post, channel.type, me);
      if (event) await enqueue(event);
    }
    if (oldest < since) return;
    const next = list.order.at(-1);
    if (oldest < previousTime) tiedCursors.clear();
    if (!isMattermostId(next) || tiedCursors.has(next) || oldest > previousTime) {
      throw new Error("Channel history cursor did not advance");
    }
    previousTime = oldest;
    tiedCursors.add(next);
    url.searchParams.set("before", next);
  }
}

export async function recoverPosts({ session, me, since, until, enqueue, signal }) {
  const url = new URL(session.client.getUserRoute("me") + "/channels");
  url.searchParams.set("include_deleted", "true");
  const channels = await readEventJson(session, url, signal);
  if (!Array.isArray(channels)) throw new Error("Invalid channel memberships");
  const guard = new ResourceGuard(session);
  for (const channel of channels) {
    signal.throwIfAborted();
    if (
      !isMattermostId(channel.id) ||
      !["D", "G", "P", "O"].includes(channel.type) ||
      (Number.isFinite(channel.last_post_at) && channel.last_post_at < since) ||
      !(await guard.channelAllowed(channel.id, channel))
    )
      continue;
    try {
      await replayChannel({ session, channel, since, until, me, enqueue, signal });
    } catch (error) {
      // Membership can disappear between listing channels and fetching history.
      if (![403, 404].includes(error?.status_code)) throw error;
    }
  }
}
