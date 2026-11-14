import { z } from "zod";
import { isAbsolute } from "node:path";
import { accountId } from "./account-store.js";
const expected_revision = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .optional();
const source_file = z
  .string()
  .max(4096)
  .refine(isAbsolute)
  .describe("Owner-only JSON credential input; secret contents are never returned.");
export const accountAdminTools = [
  {
    name: "list_accounts",
    title: "List account registry",
    description: "List configured verified identities and health without credentials.",
    inputSchema: z.object({}).strict(),
    run: (m) => m.listAccounts(),
  },
  {
    name: "add_account",
    title: "Add an account",
    description:
      "Verify and persist a new account from a private source file. Duplicate identities are rejected.",
    write: true,
    inputSchema: z.object({ source_file, expected_revision }).strict(),
    run: (m, a) => m.addAccount(a.source_file, a.expected_revision),
  },
  {
    name: "update_account",
    title: "Update an account",
    description:
      "Change an account label or enable/disable it independently. Disabled accounts cannot be selected.",
    write: true,
    inputSchema: z
      .object({
        account_id: accountId,
        label: z.string().min(1).max(100).optional(),
        enabled: z.boolean().optional(),
        expected_revision,
      })
      .strict()
      .refine((a) => a.label !== undefined || a.enabled !== undefined),
    run: (m, { account_id, expected_revision, ...patch }) =>
      m.updateAccount(account_id, patch, expected_revision),
  },
  {
    name: "rotate_account",
    title: "Rotate an account credential",
    description:
      "Validate a replacement private token source against the same account and server before activation.",
    write: true,
    inputSchema: z.object({ account_id: accountId, source_file, expected_revision }).strict(),
    run: (m, a) => m.rotateAccount(a.account_id, a.source_file, a.expected_revision),
  },
];
