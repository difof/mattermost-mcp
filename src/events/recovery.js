import { isMattermostId, selectPost } from "./filter.js";
import { readEventJson } from "./api.js";

const pageSize = 60;

// Stream pages newest-first down to the fixed snapshot cutoff. Preserve the IDs of rows
// that existed before this scan to find offline deletes without requiring admin access.
async function replayChannel({ session, channel, since, until, me, cache, signal }) {
  const missing = new Set(await cache.cachedIds(channel.id, since, until));
  if (!missing.size && Number.isFinite(channel.last_post_at) && channel.last_post_at < since)
    return;
  const url = new URL(session.client.getChannelRoute(channel.id) + "/posts");
  url.searchParams.set("per_page", String(pageSize));
  url.searchParams.set("skipFetchThreads", "true");
  let previousTime = Infinity;
  const tiedCursors = new Set();
  for (;;) {
    signal.throwIfAborted();
    const list = await readEventJson(session, url, signal);
    if (!Array.isArray(list.order) || !list.posts) throw new Error("Invalid post list");
    if (!list.order.length) break;
    let oldest = Infinity;
    const batch = [];
    for (const id of list.order) {
      const post = list.posts[id];
      if (
        !post ||
        post.id !== id ||
        post.channel_id !== channel.id ||
        !Number.isSafeInteger(post.create_at)
      )
        throw new Error("Invalid post in channel history");
      oldest = Math.min(oldest, post.create_at);
      if (post.create_at < since || post.create_at > until) continue;
      const record = selectPost(post, channel.type, me);
      if (record) {
        missing.delete(id);
        batch.push(record);
      }
    }
    signal.throwIfAborted();
    if (batch.length) await cache.enqueueBatch(batch);
    if (oldest < since) break;
    const next = list.order.at(-1);
    if (oldest < previousTime) tiedCursors.clear();
    if (!isMattermostId(next) || tiedCursors.has(next) || oldest > previousTime) {
      throw new Error("Channel history cursor did not advance");
    }
    previousTime = oldest;
    tiedCursors.add(next);
    url.searchParams.set("before", next);
  }
  // Never infer deletions from an incomplete scan. The store does not remove records
  // with a later live edit, and a tombstone cannot be overwritten by a stale page.
  signal.throwIfAborted();
  if (missing.size) await cache.reconcileMissing(channel.id, missing, until);
}

export async function recoverPosts({ session, channels, me, since, until, cache, signal }) {
  for (const channel of channels.values()) {
    signal.throwIfAborted();
    try {
      await replayChannel({ session, channel, since, until, me, cache, signal });
    } catch (error) {
      if (![403, 404].includes(error?.status_code)) throw error;
      // Membership can disappear between listing channels and reading their history.
      channels.delete(channel.id);
      await cache.purgeChannel(channel.id);
    }
  }
}
