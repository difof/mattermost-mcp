import { z } from "zod";
import { postAccess } from "../events/post-presentation.js";
import { receiptKey } from "../events/inbox.js";
import { cacheAccess } from "../events/cache-access.js";

const id = z.string().regex(/^[a-z0-9]{26}$/);

export const cacheFilterShape = {
  direction: z
    .enum(["incoming", "outgoing"])
    .optional()
    .describe("Incoming: authored by others; outgoing: authored by this account."),
  channel_id: id.optional().describe("Exact Mattermost channel ID."),
  sender_id: id.optional().describe("Exact Mattermost author ID."),
  channel_type: z
    .enum(["D", "G", "O", "P"])
    .optional()
    .describe("One-to-one DM, group DM, public or private channel respectively."),
  is_mention: z.boolean().optional().describe("Whether the post explicitly mentions this account."),
};

export function toCacheFilters({
  direction,
  channel_id,
  sender_id,
  channel_type,
  is_mention,
  since,
}) {
  return Object.fromEntries(
    Object.entries({
      direction,
      channelId: channel_id,
      senderId: sender_id,
      channelType: channel_type,
      isMention: is_mention,
      since,
    }).filter(([, value]) => value !== undefined),
  );
}

export const cachedMessagesTool = {
  name: "list_cached_messages",
  title: "List recently cached messages",
  localWrite: true,
  description:
    "Pull retained messages, newest first. Every returned post increments its local readCount (first pull: 1), shared by all agents. No Mattermost read receipts. Use unread_only for posts not yet pulled. Combine filters, e.g. channel_type D and sender_id for one person's DMs. Membership and content access are verified. Continue with nextCursor and the same filters.",
  inputSchema: z
    .object({
      ...cacheFilterShape,
      request_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          "Optional unique UUID for this page. Retry the same UUID and arguments within 10 minutes without consuming twice.",
        ),
      unread_only: z
        .boolean()
        .optional()
        .describe("Select only posts with readCount zero before this pull."),
      since: z
        .number()
        .int()
        .nonnegative()
        .safe()
        .optional()
        .describe("Earliest post creation time to include, in Unix milliseconds."),
      limit: z.number().int().min(1).max(100).default(25),
      cursor: z
        .string()
        .min(1)
        .max(128)
        .optional()
        .describe("Opaque nextCursor from the previous page with the same filters."),
    })
    .strict(),
  compact: true,
  handler: async (args, { session, callerSessionId, signal }) => {
    const cache = session.cache;
    const access = await cacheAccess(session, cache, signal);
    if (args.channel_id) {
      await access.check([args.channel_id]);
      if (!access.allows(args.channel_id))
        throw new Error("Channel is not an accessible joined channel");
    }
    const posts = postAccess(session, cache, access, signal);
    const filters = {
      ...toCacheFilters(args),
      unreadOnly: args.unread_only,
      cursor: args.cursor,
      limit: args.limit,
    };
    const receipt = receiptKey(args.request_id, callerSessionId, filters);
    filters.excludedChannels = access.excluded;
    // A purge or a live post during a check can move unverified channels onto the
    // page. Only return a freshly read page (including its cursor) that passed.
    for (let checks = 0; ; checks++) {
      const { page, unverified, unverifiedPosts } = cache.pullPage(
        filters,
        access.allows,
        receipt,
        posts,
      );
      if (page) return { ...page, syncState: session.cacheStatus };
      if (checks === (posts ? 8 : 3))
        throw new Error("The cache page changed during access checks; retry this pull");
      if (unverifiedPosts) await posts.check(unverifiedPosts);
      else await access.check(unverified);
    }
  },
};
