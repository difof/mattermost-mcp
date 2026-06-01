// `mattermost-mcp status` — resolve the effective config (saved login + env),
// authenticate, and print the current identity. Proves the saved credentials work.
import { resolveConfig } from "../credentials.js";
import { createSession } from "../mattermost/client.js";

export async function runStatus(): Promise<void> {
  let config;
  try {
    config = resolveConfig();
  } catch {
    process.stdout.write(
      "Not logged in. Run `mattermost-mcp login`, or set MM_URL + credentials.\n",
    );
    process.exitCode = 1;
    return;
  }

  const session = await createSession(config);
  const me = await session.call((c) => c.getMe());
  process.stdout.write(
    `Logged in as @${me.username} (${me.id})\n` +
      `  server:    ${config.url}\n` +
      `  auth mode: ${config.auth.mode}\n` +
      `  read-only: ${config.guardrails.readOnly}\n`,
  );
}
