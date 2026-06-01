import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveConfig } from "./credentials.js";
import { createSession } from "./mattermost/client.js";
import { registerTools } from "./tools/registry.js";
import { allTools } from "./tools/index.js";
import { log } from "./log.js";

/**
 * Start the MCP server on stdio. Configuration comes from `resolveConfig`:
 * saved `login` credentials are the baseline, overridden by any `MM_*` env vars.
 * Fails fast on bad config, then authenticates before serving.
 */
export async function runServer(): Promise<void> {
  const config = resolveConfig();
  const session = await createSession(config);

  const server = new Server(
    { name: "mattermost-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // tools/list + tools/call dispatched from the registry, sharing the session.
  registerTools(server, allTools, { session });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("server running on stdio");
}
