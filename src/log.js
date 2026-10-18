// IMPORTANT: stdout is the MCP stdio channel. All logging goes to stderr only.
export function log(message) {
  console.error(`[mattermost-mcp] ${message}`);
}
