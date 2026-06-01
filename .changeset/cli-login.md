---
"@bryanberger/mattermost-mcp": minor
---

Add a management CLI to the `mattermost-mcp` binary. After `npm i -g @bryanberger/mattermost-mcp`, run `mattermost-mcp login` for an interactive auth wizard (PAT, password, or OAuth2) that validates and saves credentials (0600) under the config dir; the MCP server then uses them automatically — no env vars required. Also adds `status` (print the authenticated identity) and `logout` (clear saved credentials). `MM_*` environment variables still take precedence over saved credentials. Password logins are exchanged for a session token at login time, so no password is ever written to disk.
