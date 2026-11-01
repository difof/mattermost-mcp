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

// Decisions last one tool call or delivery batch, never an entire service session.
export async function cacheAccess(session, cache, signal = new AbortController().signal) {
  const joined = await listAccessibleChannels(session, signal);
  cache.retainChannels(joined.keys());
  const decisions = new Map();
  return {
    allows: (id) => decisions.get(id) === true,
    async check(ids) {
      const unknown = [...new Set(ids)].filter((id) => !decisions.has(id));
      for (let i = 0; i < unknown.length; i += 4) {
        const batch = await Promise.allSettled(
          unknown.slice(i, i + 4).map(async (id) => {
            const allowed = joined.has(id) && (await mayReadPosts(session, id, signal));
            decisions.set(id, allowed);
            if (!allowed) cache.purgeChannel(id);
          }),
        );
        const failure = batch.find((r) => r.status === "rejected");
        if (failure) throw failure.reason;
      }
    },
  };
}
