import { z } from "zod";
import { routeSegment } from "./route-params.js";
import { doClientFetch } from "../mattermost/client.js";
export const typingTool = {
  name: "publish_typing",
  title: "Publish typing indicator",
  write: true,
  description:
    "Publish a short-lived typing pulse as the selected account. Only call during active work; it is not queued or replayed.",
  inputSchema: z.object({ channel_id: routeSegment, parent_id: routeSegment.optional() }).strict(),
  resources: (args) => ({ channelId: args.channel_id, postId: args.parent_id }),
  handler: async (args, { session, resources }) => {
    await session.call((c) => c.getChannelMember(args.channel_id, session.userId));
    if (args.parent_id) await resources.assertAnchor(args.parent_id, args.channel_id);
    await session.call((c) =>
      doClientFetch(c, c.getUserRoute(session.userId) + "/typing", {
        method: "POST",
        body: JSON.stringify({
          channel_id: args.channel_id,
          ...(args.parent_id ? { parent_id: args.parent_id } : {}),
        }),
      }),
    );
    return {
      account_id: session.accountId ?? session.userId,
      channel_id: args.channel_id,
      published: true,
    };
  },
};
