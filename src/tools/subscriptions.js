import { z } from "zod";
import { cacheFilterShape, toCacheFilters } from "./cached-messages.js";
export const subscriptionTools = [
  {
    name: "subscribe_messages",
    title: "Subscribe to new Mattermost messages",
    write: true,
    description:
      "Create or renew an timed or permanent subscription for new posts matching every supplied filter. In OpenCode, omit the destination to notify the calling session. Other clients must pass an exact session_id OR an operator-enabled callback_url. An explicit destination takes precedence over caller metadata. Metadata only. For DMs use direction incoming and channel_type D. Set persistent=true or ttl_seconds (1–172800), not both. Does not send a Mattermost message.",
    inputSchema: z
      .object({
        ...cacheFilterShape,
        ttl_seconds: z.number().int().min(1).max(172800).optional(),
        persistent: z.boolean().optional(),
        include_service_outgoing: z.boolean().optional(),
        session_id: z
          .string()
          .regex(/^ses_[A-Za-z0-9]{1,100}$/)
          .optional(),
        callback_url: z.string().url().max(2048).optional(),
      })
      .strict()
      .refine(
        (args) =>
          args.persistent === true
            ? args.ttl_seconds === undefined
            : args.ttl_seconds !== undefined,
        "Set persistent=true or ttl_seconds, not both",
      ),
    handler: (args, { session, callerSessionId }) => {
      const target =
        args.session_id === undefined && args.callback_url === undefined && callerSessionId
          ? { ...args, session_id: callerSessionId }
          : args;
      return session.subscriptions.register(target, {
        ...toCacheFilters(args),
        includeServiceOutgoing: args.include_service_outgoing ?? false,
      });
    },
  },
  {
    name: "list_message_subscriptions",
    title: "List active message subscriptions",
    description: "List the selected account's active message callbacks, filters and expiry times.",
    inputSchema: z.object({}).strict(),
    handler: (_args, { session }) => session.subscriptions.list(),
  },
  {
    name: "unsubscribe_messages",
    title: "Cancel a message subscription",
    write: true,
    description:
      "Stop a callback using the subscription_id returned by subscribe_messages. An already accepted delivery cannot be recalled.",
    inputSchema: z.object({ subscription_id: z.string().uuid() }).strict(),
    handler: (args, { session }) => session.subscriptions.unsubscribe(args.subscription_id),
  },
];
