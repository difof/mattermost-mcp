// Shared on-disk locations. Everything mattermost-mcp persists (OAuth token
// cache, login credentials) lives under one config directory, 0600 per file.
import { homedir } from "node:os";
import { join } from "node:path";

/** Base config directory: `$XDG_CONFIG_HOME/mattermost-mcp` or `~/.config/mattermost-mcp`. */
export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return join(xdg && xdg.length > 0 ? xdg : join(homedir(), ".config"), "mattermost-mcp");
}

/** Path of the credentials file written by `mattermost-mcp login`. */
export function credentialsFile(): string {
  return join(configDir(), "credentials.json");
}
