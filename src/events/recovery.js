import { isMattermostId, selectPost } from "./filter.js";
import { readEventJson } from "./api.js";

const pageSize = 60;
const maxPageSize = 200;

function historyPosts(list, channelId) {
  if (!Array.isArray(list?.order) || !list.posts) throw new Error("Invalid post list");
  return list.order.map((id) => {
    const post = list.posts[id];
    if (
      !isMattermostId(id) ||
      post?.id !== id ||
      post.channel_id !== channelId ||
      !Number.isSafeInteger(post.create_at)
    )
      throw new Error("Invalid post in channel history");
    return post;
  });
}

// v11's before=ID actually means CreateAt < timestamp(ID). Anchor on a strictly
// newer row so the complete oldest millisecond is replayed, including unseen ties.
// Widen a full tied page before resorting to offsets, which can shift under writes.
async function* historyPages(session, channelId, since, signal) {
  const url = new URL(session.client.getChannelRoute(channelId) + "/posts");
  url.searchParams.set("per_page", String(pageSize));
  url.searchParams.set("skipFetchThreads", "true");
  let anchorTime = Infinity,
    page = 0,
    size = pageSize;
  const tiedPages = new Set();
  for (;;) {
    signal.throwIfAborted();
    const posts = historyPosts(await readEventJson(session, url, signal), channelId);
    if (!posts.length) return;
    const oldest = Math.min(...posts.map((p) => p.create_at));
    if (posts.some((p) => p.create_at >= anchorTime))
      throw new Error("Channel history cursor did not advance");
    const anchor = posts.findLast((p) => p.create_at > oldest);
    const fullTie = !anchor && posts.length >= size;
    const needsOffset = fullTie && size === maxPageSize && oldest > since;
    yield { posts, needsOffset };
    if (oldest <= since) return;
    if (fullTie && size < maxPageSize) {
      size = maxPageSize;
      url.searchParams.set("per_page", String(size));
      continue;
    }
    if (needsOffset) {
      // v11 has no ID tiebreaker within this millisecond. Collect what is visible,
      // but do not advertise a fully reconciled cache even if offsets look stable.
      const key = posts
        .map((p) => p.id)
        .sort()
        .join();
      if (!tiedPages.has(key)) {
        tiedPages.add(key);
        url.searchParams.set("page", String(++page));
        continue;
      }
    }
    const before = anchor ?? posts.at(-1);
    anchorTime = before.create_at;
    url.searchParams.set("before", before.id);
    url.searchParams.delete("page");
    size = pageSize;
    url.searchParams.set("per_page", String(size));
    page = 0;
    tiedPages.clear();
  }
}

// History pages are not a server-side snapshot. A concurrent deletion or reordered
// tie can shift an offset; verify apparent misses by ID before clearing cached bodies.
async function verifyMissing({ session, channel, missing, me, cache, signal, until, current }) {
  const removed = [];
  for (const id of missing) {
    if (!current(channel.id)) return;
    let post;
    try {
      post = await readEventJson(session, session.client.getPostRoute(id), signal);
    } catch (error) {
      if (![403, 404].includes(error?.status_code)) throw error;
      removed.push(id);
      continue;
    }
    signal.throwIfAborted();
    if (!current(channel.id)) return;
    if (post?.id !== id || post.channel_id !== channel.id) throw new Error("Invalid missing post");
    const record = selectPost(post, channel.type, me);
    if (record) await cache.enqueueBatch([record]);
    else removed.push(id);
  }
  signal.throwIfAborted();
  if (removed.length && current(channel.id))
    await cache.reconcileMissing(channel.id, removed, until);
}

async function replayChannel({ session, channel, since, until, me, cache, signal, current }) {
  const missing = new Set(await cache.cachedIds(channel.id, since, until));
  // LastPostAt is updated after the post commits and may be stale even on success.
  let complete = true;
  for await (const { posts, needsOffset } of historyPages(session, channel.id, since, signal)) {
    if (!current(channel.id)) return true;
    if (needsOffset) complete = false;
    const batch = [];
    for (const post of posts) {
      if (post.create_at <= since || post.create_at > until) continue;
      const record = selectPost(post, channel.type, me);
      if (record) {
        missing.delete(post.id);
        batch.push(record);
      }
    }
    signal.throwIfAborted();
    if (batch.length) await cache.enqueueBatch(batch);
  }
  await verifyMissing({ session, channel, missing, me, cache, signal, until, current });
  return complete;
}

export async function recoverPosts({
  session,
  channels,
  me,
  since,
  until,
  cache,
  signal,
  current = () => true,
  onUnavailable = () => {},
  onAmbiguous = () => {},
  onDenied = cache.purgeChannel,
}) {
  let allComplete = true;
  for (const channel of channels.values()) {
    signal.throwIfAborted();
    if (!current(channel.id)) continue;
    try {
      const complete = await replayChannel({
        session,
        channel,
        since,
        until,
        me,
        cache,
        signal,
        current,
      });
      if (!complete) {
        allComplete = false;
        onAmbiguous(channel);
      }
    } catch (error) {
      signal.throwIfAborted();
      if (error?.status_code === 401) throw error;
      if (!current(channel.id)) continue;
      if ([403, 404].includes(error?.status_code)) await onDenied(channel.id);
      else {
        // A malformed or temporarily unavailable channel must not starve later
        // channels, or force the healthy authenticated socket to disconnect.
        allComplete = false;
        onUnavailable(channel);
      }
    }
  }
  return allComplete;
}
