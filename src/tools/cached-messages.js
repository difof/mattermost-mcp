import { z } from "zod";
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
  description:
    "Read the local message cache within its configured retention window (default 48 hours), newest first. All supplied filters must match. For DMs from one person, use channel_type D and sender_id; for channel mentions, use is_mention and channel_id. Set direction outgoing for messages sent by this account. Channel membership, allowlists and permission to read posts are checked before each page. Continue with nextCursor and the same filters.",
  inputSchema: z
    .object({
      ...cacheFilterShape,
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
  handler: async (args, { session }) => {
    const cache = session.cache;
    const access = await cacheAccess(session, cache);
    if (args.channel_id) {
      await access.check([args.channel_id]);
      if (!access.allows(args.channel_id))
        throw new Error("Channel is not an accessible joined channel");
    }
    const filters = { ...toCacheFilters(args), cursor: args.cursor, limit: args.limit };
    // A purge or a live post during a check can move unverified channels onto the
    // page. Only return a freshly read page (including its cursor) that passed.
    for (let checks = 0; ; checks++) {
      const page = cache.list(filters);
      const ids = page.messages.map((row) => row.channelId);
      if (ids.every(access.allows)) return { ...page, syncState: session.cacheStatus };
      if (checks === 3)
        throw new Error("The cache page changed during access checks; retry this pull");
      await access.check(ids);
    }
  },
};
