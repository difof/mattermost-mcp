import { z } from "zod";
import { routeSegment } from "./route-params.js";

const id = z.string().regex(/^[a-z0-9]{26}$/);
export const resolveConversationTool = {
  name: "resolve_conversation",
  title: "Resolve an existing Mattermost conversation",
  description:
    "Resolve an exact username to an existing DM, or an exact channel name/ID to a joined conversation. Supply team_id to disambiguate a channel name. Returns candidates on ambiguity. Never creates, joins or sends.",
  inputSchema: z
    .object({
      username: routeSegment.optional(),
      channel_name: routeSegment.optional(),
      channel_id: id.optional(),
      team_id: id.optional(),
    })
    .strict()
    .refine(
      (a) =>
        [a.username, a.channel_name, a.channel_id].filter(Boolean).length === 1 &&
        (!a.team_id || a.channel_name),
      {
        message:
          "Provide one username, channel_name, or channel_id; team_id is only for channel_name.",
      },
    ),
  compact: true,
  async handler(args, { session, signal }) {
    let userId;
    if (args.username) {
      let user;
      try {
        user = await session.call((c) => c.getUserByUsername(args.username));
      } catch (error) {
        if (error?.status_code === 404) return { status: "not_found" };
        throw error;
      }
      if (
        !id.safeParse(user?.id).success ||
        user.username?.toLowerCase() !== args.username.toLowerCase()
      )
        throw new Error("Unexpected user lookup result");
      userId = user.id;
    }
    await session.cache.refreshDirectory(signal);
    const filters = userId
      ? { channel_type: "D", peer_user_id: userId }
      : args.channel_id
        ? { channel_id: args.channel_id }
        : { exact_name: args.channel_name, team_id: args.team_id };
    const { conversations, nextCursor } = session.cache.directory.list({ ...filters, limit: 25 });
    if (!conversations.length) return { status: "not_found", ...(userId ? { userId } : {}) };
    if (conversations.length === 1 && !nextCursor)
      return { status: "resolved", conversation: conversations[0] };
    return { status: "ambiguous", candidates: conversations, hasMore: !!nextCursor };
  },
};
