import { z } from "zod";
export const accountTools = [
  {
    name: "list_accounts",
    title: "List configured Mattermost accounts",
    accountIndependent: true,
    description:
      "List verified account identifiers, status and any explicitly configured default. Pass account_id on subsequent operations; credentials are never returned.",
    inputSchema: z.object({}).strict(),
    handler: (_args, { session }) =>
      session.accounts?.list() ?? {
        default_account_id: session.accountId ?? session.userId,
        accounts: [
          {
            account_id: session.accountId ?? session.userId,
            user_id: session.userId,
            url: session.config.url,
            enabled: true,
            status: "ready",
          },
        ],
      },
  },
];
