import { listAccessibleChannels, readEventJson } from "./api.js";

// A v11 channel membership does not itself grant ReadChannelContent. Probe its
// history with the same account, requesting a single timeline entry and discarding it.
async function mayReadPosts(session, channelId, signal) {
  const url = new URL(session.client.getChannelRoute(channelId) + "/posts");
  url.searchParams.set("per_page", "1");
  url.searchParams.set("skipFetchThreads", "true");
  try {
    const result = await readEventJson(session, url, signal);
    if (
      !Array.isArray(result?.order) ||
      !result.posts ||
      typeof result.posts !== "object" ||
      Array.isArray(result.posts)
    )
      throw new Error("Invalid history response");
    return true;
  } catch (error) {
    if ([403, 404].includes(error?.status_code)) return false;
    throw new Error("Could not verify Mattermost channel content access");
  }
}

// Keep per-call decisions; only the membership coordinator owns global pruning.
// A stale lookup can filter its own page, never delete a different grant's rows.
export async function cacheAccess(session, cache, signal = new AbortController().signal) {
  const membership = cache.refreshMembership ? await cache.refreshMembership(signal) : null;
  let me = membership?.me;
  if (!me && session.config.cacheVerifyPosts) {
    const user = await readEventJson(session, session.client.getUserRoute("me"), signal);
    if (user?.id !== session.userId || !user.username)
      throw new Error("Unexpected Mattermost account");
    me = { id: user.id, username: user.username };
  }
  const joined = membership?.channels ?? (await listAccessibleChannels(session, signal));
  const decisions = new Map(),
    excluded = new Set();
  const current = (id) => !membership || membership.isCurrent(id);
  function decision(id) {
    if (excluded.has(id)) return false;
    if (!joined.has(id) || !current(id)) {
      excluded.add(id);
      return false;
    }
    return decisions.get(id);
  }
  async function verify(id) {
    if (decision(id) !== undefined) return;
    const allowed = await mayReadPosts(session, id, signal);
    if (!allowed) {
      if (membership) membership.denyContent(id);
      // Standalone caches have no running membership writer.
      else cache.purgeChannel(id);
      excluded.add(id);
    }
    if (allowed) membership?.allowContent(id);
    decisions.set(id, allowed);
  }
  return {
    excluded,
    me,
    decision,
    allows: (id) => decision(id) === true,
    denies: (id) => decision(id) === false,
    async check(ids, { partial = false } = {}) {
      const unique = [...new Set(ids)];
      for (let i = 0; i < unique.length; i += 4) {
        const results = await Promise.allSettled(unique.slice(i, i + 4).map(verify));
        signal.throwIfAborted();
        const failed = results.find((r) => r.status === "rejected");
        if (failed && !partial) throw failed.reason;
      }
    },
  };
}
