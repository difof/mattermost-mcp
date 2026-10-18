#!/usr/bin/env node
import { VERSION } from "./version.js";
import { log } from "./log.js";
const HELP = `mattermost-mcp ${VERSION}

MCP (stdio) server for the Mattermost REST API v4.

Usage:
  mattermost-mcp               Start the MCP server on stdio (default; used by MCP clients)
  mattermost-mcp login         Authenticate and save credentials to the config dir
  mattermost-mcp login --gitlab  Log in through a browser SSO window (GitLab/SAML; no admin needed)
  mattermost-mcp status        Show the current identity and server
  mattermost-mcp logout        Remove saved credentials
  mattermost-mcp --help        Show this help
  mattermost-mcp --version     Print the version

Credentials saved by \`login\` are used by the server automatically.
MM_* environment variables override saved credentials. See the README for all options.
`;
async function main() {
  const command = process.argv[2];
  switch (command) {
    case undefined:
      // No args: an MCP client launched us — serve on stdio.
      await (await import("./server.js")).runServer();
      return;
    case "login":
      await (await import("./commands/login.js")).runLogin(process.argv.slice(3));
      return;
    case "status":
    case "whoami":
      await (await import("./commands/status.js")).runStatus();
      return;
    case "logout":
      (await import("./commands/logout.js")).runLogout();
      return;
    case "help":
    case "-h":
    case "--help":
      process.stdout.write(HELP);
      return;
    case "-v":
    case "--version":
      process.stdout.write(`${VERSION}\n`);
      return;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      process.exitCode = 1;
  }
}
main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
