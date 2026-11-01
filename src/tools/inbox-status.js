import { z } from "zod";
import { cacheAccess } from "../events/cache-access.js";

export const inboxStatusTool = {
  name: "get_inbox_status",
  title: "Check inbox health without consuming messages",
  description:
    "Get cache sync state, checkpoint, and retention. Set include_counts for retained/unread totals across currently readable channels. Never returns post text, advances a subscription or increments readCount.",
  inputSchema: z.object({ include_counts: z.boolean().optional() }).strict(),
  compact: true,
  async handler({ include_counts }, { session, signal }) {
    const cache = session.cache;
    const status = {
      syncState: session.cacheStatus,
      retentionHours: cache.retentionMs / 3600000,
      checkpointAt: cache.getCheckpoint(),
      ...session.cacheHealth,
    };
    if (include_counts && session.config.cacheVerifyPosts)
      throw new Error(
        "Aggregate counts are unavailable with per-post verification; request status without counts.",
      );
    if (include_counts) {
      const access = await cacheAccess(session, cache, signal);
      const ids = cache.inboxChannels();
      await access.check(ids);
      status.counts = cache.inboxCounts(ids.filter(access.allows));
    }
    return status;
  },
};
