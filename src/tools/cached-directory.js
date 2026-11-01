import { z } from "zod";

const id = z.string().regex(/^[a-z0-9]{26}$/);

export const cachedDirectoryTool = {
  name: "list_cached_conversations",
  title: "Look up the account and joined conversations",
  description:
    "Get your account ID and username and find exact joined channel/DM IDs in the local directory, including quiet or archived memberships outside message retention. Rechecks current Mattermost membership and allowlists. A direct conversation exposes the peer user ID when identifiable. lastPostAt is a server hint, not proof of history. No message bodies or read counts are affected.",
  inputSchema: z
    .object({
      channel_type: z
        .enum(["D", "G", "O", "P"])
        .optional()
        .describe("Direct, group DM, public, or private channel."),
      channel_id: id.optional(),
      team_id: id.optional(),
      peer_user_id: id.optional().describe("Exact other user ID for a one-to-one or self DM."),
      exact_name: z
        .string()
        .min(1)
        .max(256)
        .optional()
        .describe("Exact channel name (not its display name)."),
      query: z
        .string()
        .trim()
        .min(1)
        .max(128)
        .optional()
        .describe("Literal text in the channel name or display name."),
      limit: z.number().int().min(1).max(100).default(25),
      cursor: z
        .string()
        .regex(/^[a-z0-9]{26}(?:\.[0-9a-f-]{36})?$/)
        .optional()
        .describe("Use nextCursor from the prior page with the same filters."),
    })
    .strict(),
  compact: true,
  async handler(args, { session, signal }) {
    const cache = session.cache;
    return cache.directoryPage(
      args,
      () => ["connected", "partial"].includes(session.cacheStatus),
      signal,
    );
  },
};
