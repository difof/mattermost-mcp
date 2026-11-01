import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { buildToolList } from "../tools/registry.js";
import { VERSION } from "../version.js";
import { settingsPatchSchema } from "./settings.js";

const expected_revision = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .optional()
  .describe("Revision from list_settings. Reject changes if another update has won.");
const definitions = [
  {
    name: "list_settings",
    title: "List service settings",
    description:
      "Show effective MCP service settings, revision, reload behavior and credential status. Secret values are never returned.",
    inputSchema: z.object({}).strict(),
    run: (manager) => manager.list(),
  },
  {
    name: "set_settings",
    title: "Update service settings",
    write: true,
    description:
      "Validate and persist an allowed settings patch. Apply live settings and report pending restart changes. Do not pass secrets.",
    inputSchema: z.object({ patch: settingsPatchSchema, expected_revision }).strict(),
    run: (manager, args) => manager.set(args.patch, args.expected_revision),
  },
  {
    name: "reload_settings",
    title: "Reload service configuration",
    write: true,
    description:
      "Reread configured settings and private credential sources, verify the account, and apply the valid configuration. No secret input is accepted.",
    inputSchema: z.object({ expected_revision }).strict(),
    run: (manager, args) => manager.reload(args.expected_revision),
  },
];

const safeErrors = new Map(
  Object.entries({
    REVISION_CONFLICT:
      "Settings changed since the expected revision. Read list_settings before retrying.",
    INVALID_SETTINGS: "Invalid service settings. Check the supported keys and value ranges.",
    INVALID_CREDENTIALS: "Credential validation failed. Check the configured private source.",
    ACCOUNT_MISMATCH: "The replacement credential belongs to a different Mattermost account.",
    RELOAD_FAILED: "Reload failed. Check the configured files and service health.",
    SAVE_FAILED: "Could not persist settings. Check the settings file permissions.",
    BUSY: "Another configuration change is in progress. Retry after it completes.",
    ROLLBACK_FAILED: "Recovery failed. Inspect the service before retrying.",
  }),
);
const failure = (text) => ({ isError: true, content: [{ type: "text", text }] });
const tools = buildToolList(definitions);

/** Separate protocol server: ordinary Mattermost operations never enter this catalog. */
export function makeAdminMcpServer(manager, exchange) {
  const server = new Server(
    { name: "mattermost-mcp-admin", version: VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => tools);
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const definition = definitions.find((d) => d.name === params.name);
    if (!definition) throw new McpError(ErrorCode.InvalidParams, "Unknown management tool");
    const args = definition.inputSchema.safeParse(params.arguments ?? {});
    // In particular, never echo arbitrary keys, values, filesystem errors or upstream auth errors.
    if (!args.success) return failure("Invalid management arguments; see the tool's input schema.");
    try {
      const run = () => definition.run(manager, args.data);
      // A committed management operation must still drain after the peer closes.
      const result = await (exchange ? exchange.track(run) : run());
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return failure(
        safeErrors.get(error?.code) ?? "Settings operation failed. Check service health.",
      );
    }
  });
  return server;
}
