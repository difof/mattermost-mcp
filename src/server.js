import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveConfig } from "./credentials.js";
import { createSession } from "./mattermost/client.js";
import { registerTools } from "./tools/registry.js";
import { allTools } from "./tools/index.js";
import { cachedMessagesTool } from "./tools/cached-messages.js";
import { subscriptionTools } from "./tools/subscriptions.js";
import { log } from "./log.js";
import { VERSION } from "./version.js";
/** Each transport owns its MCP protocol state; the authenticated account can be shared. */
export function makeMcpServer(session) {
  const server = new Server(
    { name: "mattermost-mcp", version: VERSION },
    { capabilities: { tools: {} } },
  );
  // tools/list + tools/call dispatched from the registry, sharing the session.
  const tools = session.cache ? [...allTools, cachedMessagesTool, ...subscriptionTools] : allTools;
  registerTools(server, tools, { session });
  return server;
}
export async function runServer() {
  const server = makeMcpServer(await createSession(resolveConfig()));
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("server running on stdio");
}
