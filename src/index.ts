#!/usr/bin/env node
import { createRequire } from "node:module";
import { runServer } from "./server.js";
import { runLogin } from "./commands/login.js";
import { runLogout } from "./commands/logout.js";
import { runStatus } from "./commands/status.js";
import { log } from "./log.js";

// dist/index.js → ../package.json resolves to the package root at runtime.
const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const HELP = `mattermost-mcp ${version}

MCP (stdio) server for the Mattermost REST API v4.

Usage:
  mattermost-mcp              Start the MCP server on stdio (default; used by MCP clients)
  mattermost-mcp login        Authenticate and save credentials to the config dir
  mattermost-mcp status       Show the current identity and server
  mattermost-mcp logout       Remove saved credentials
  mattermost-mcp --help       Show this help
  mattermost-mcp --version    Print the version

Credentials saved by \`login\` are used by the server automatically.
MM_* environment variables override saved credentials. See the README for all options.
`;

async function main(): Promise<void> {
  const command = process.argv[2];
  switch (command) {
    case undefined:
      // No args: an MCP client launched us — serve on stdio.
      await runServer();
      return;
    case "login":
      await runLogin();
      return;
    case "status":
    case "whoami":
      await runStatus();
      return;
    case "logout":
      runLogout();
      return;
    case "help":
    case "-h":
    case "--help":
      process.stdout.write(HELP);
      return;
    case "-v":
    case "--version":
      process.stdout.write(`${version}\n`);
      return;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
