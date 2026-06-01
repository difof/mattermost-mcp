# mattermost-mcp

A Node.js 20 / TypeScript MCP server over **stdio** that wraps the official
[`@mattermost/client`](https://github.com/mattermost/mattermost/tree/master/webapp/packages/client)
Client4 (REST v4). It authenticates to a **self-hosted** Mattermost instance and exposes
**34 tools** across messaging, channels/teams, users/presence, and file operations. Safe-by-default
via a configurable guardrail layer; all output goes to stdout (the MCP channel) and all logging goes
to stderr.

> **Self-hosted only.** Mattermost Cloud does not expose the REST v4 endpoints used here; you need
> a self-managed Mattermost server (any recent version supporting REST v4).

## Features

- **3 authentication modes** — Personal Access Token (default), username/password (+MFA), OAuth2
  (authorization-code + PKCE S256 with transparent token refresh).
- **34 tools** across 4 domains — messaging (13), channels & teams (12), users & presence (6),
  files (3).
- **Safe by default** — read-only mode (`MM_READ_ONLY`), destructive-action gate
  (`MM_ALLOW_DESTRUCTIVE`), team/channel allowlists, and per-call `confirm: true` requirement for
  destructive tools.
- **Resilience** — configurable request timeout, retry with exponential back-off + jitter on `429` /
  `5xx` / network errors.
- **Strict validation** — every tool input is validated with a Zod schema before any API call.
  Mattermost errors are surfaced verbatim (status code + message).

## Requirements

- Node.js ≥ 20
- A self-hosted Mattermost server with a user account and credentials (PAT, login/password, or an
  OAuth2 application)

## Install

### Global (recommended)

```bash
npm i -g @bryanberger/mattermost-mcp
mattermost-mcp login        # interactive: server URL + auth, saved to the config dir
mattermost-mcp status       # verify: prints the authenticated identity
```

`login` validates the credentials against the server and writes them (0600) under
`$XDG_CONFIG_HOME/mattermost-mcp` (or `~/.config/mattermost-mcp`). The MCP server then picks them up
automatically — no env vars required. See [CLI](#cli) and [Authenticate with `login`](#authenticate-with-login).

### From source

```bash
npm install
npm run build
# Binary is now at dist/index.js (also available as mattermost-mcp via the bin field)
```

## CLI

The `mattermost-mcp` binary is both the MCP server and a small management CLI:

| Command                 | Description                                                             |
| ----------------------- | ----------------------------------------------------------------------- |
| `mattermost-mcp`        | Start the MCP server on stdio (default — this is what MCP clients run). |
| `mattermost-mcp login`  | Interactive auth wizard; validates and saves credentials.               |
| `mattermost-mcp status` | Authenticate with the resolved config and print the current identity.   |
| `mattermost-mcp logout` | Remove saved credentials (and the matching OAuth token cache).          |
| `mattermost-mcp --help` | Usage. `--version` prints the version.                                  |

## Authenticate with `login`

```text
$ mattermost-mcp login
Mattermost server URL (e.g. https://mm.example.com): https://mattermost.example.com
Authentication mode:
  1) pat       paste a Personal Access Token
  2) password  username/email + password (+ MFA)
  3) oauth2    OAuth2 app + browser consent
Choice [1]: 1
Personal Access Token: ********
✓ Logged in as @alice on https://mattermost.example.com
  Saved to ~/.config/mattermost-mcp/credentials.json (mode: pat, 0600)
```

- **pat** — saves the token as-is.
- **password** — exchanges your password for a **session token** and saves _that_ (the password is
  never written to disk); re-run `login` when the session expires.
- **oauth2** — runs the browser consent flow and caches the OAuth tokens (refreshed transparently).

## Configuration

Credentials come from two sources, in order of precedence:

1. **Environment variables** (`MM_*`) — always win; ideal for CI and the `examples/` MCP client configs.
2. **Saved `login` credentials** — the baseline when the matching env vars are absent.

In development you can place env vars in a `.env` file in the project root and export them before
running; in production pass them directly to the process. A fully annotated `.env.example` ships in
the repository. Every setting below is also configurable via env.

### Environment Variables

#### Connection

| Variable | Required | Default | Description                                                                               |
| -------- | -------- | ------- | ----------------------------------------------------------------------------------------- |
| `MM_URL` | **yes**  | —       | Server root URL, no trailing slash, no `/api/v4` (e.g. `https://mattermost.example.com`). |

#### Authentication

| Variable            | Required        | Default                          | Description                                                                                                  |
| ------------------- | --------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `MM_AUTH_MODE`      | no              | `pat`                            | One of `pat \| password \| oauth2`.                                                                          |
| `MM_TOKEN`          | when `pat`      | —                                | Personal Access Token (Bearer; no expiry). Enable in System Console → Integrations → Personal Access Tokens. |
| `MM_LOGIN_ID`       | when `password` | —                                | Username or email.                                                                                           |
| `MM_PASSWORD`       | when `password` | —                                | Password.                                                                                                    |
| `MM_MFA_TOKEN`      | no              | —                                | MFA one-time code (only if the account enforces MFA).                                                        |
| `MM_CLIENT_ID`      | when `oauth2`   | —                                | OAuth2 app client id (register in System Console → Integrations → OAuth 2.0 Applications).                   |
| `MM_CLIENT_SECRET`  | when `oauth2`   | —                                | OAuth2 app client secret.                                                                                    |
| `MM_OAUTH_REDIRECT` | no              | `http://127.0.0.1:7000/callback` | Loopback redirect URI (must start with `http://` or `https://`).                                             |

#### Guardrails

| Variable               | Required | Default          | Description                                                                                                 |
| ---------------------- | -------- | ---------------- | ----------------------------------------------------------------------------------------------------------- |
| `MM_READ_ONLY`         | no       | `false`          | `true` disables every write/destructive tool (they hard-refuse at call time; still listed in `tools/list`). |
| `MM_ALLOW_DESTRUCTIVE` | no       | `false`          | Gates the 💥 destructive tools; they also require `confirm: true` per call.                                 |
| `MM_TEAM_ALLOWLIST`    | no       | _(unrestricted)_ | CSV of team ids; actions targeting teams outside this list are refused.                                     |
| `MM_CHANNEL_ALLOWLIST` | no       | _(unrestricted)_ | CSV of channel ids; actions targeting channels outside this list are refused.                               |
| `MM_MAX_MESSAGE_LEN`   | no       | `16383`          | Reject messages longer than this (Unicode code points) before sending.                                      |

#### Resilience

| Variable                | Required | Default | Description                                                                   |
| ----------------------- | -------- | ------- | ----------------------------------------------------------------------------- |
| `MM_REQUEST_TIMEOUT_MS` | no       | `30000` | Per-request timeout in ms (`0` disables).                                     |
| `MM_MAX_RETRIES`        | no       | `3`     | Retries on `429` / `5xx` / network errors with exponential back-off + jitter. |
| `MM_RETRY_BASE_MS`      | no       | `500`   | Back-off base delay in ms.                                                    |

## Authentication Modes

### pat (default, recommended)

Create a Personal Access Token in **System Console → Integrations → Personal Access Tokens**, then:

```bash
MM_AUTH_MODE=pat
MM_TOKEN=your-personal-access-token
```

No expiry; revocable at any time; simplest setup.

### password

```bash
MM_AUTH_MODE=password
MM_LOGIN_ID=your-username-or-email
MM_PASSWORD=your-password
# MM_MFA_TOKEN=123456   # only if the account enforces MFA
```

The server calls `POST /users/login`, captures the session token from the `Token` response header,
and automatically re-authenticates on a `401`.

### oauth2

Register a **confidential** OAuth2 application in **System Console → Integrations → OAuth 2.0
Applications** with a loopback redirect URI (`http://127.0.0.1:7000/callback` by default), then:

```bash
MM_AUTH_MODE=oauth2
MM_CLIENT_ID=your-client-id
MM_CLIENT_SECRET=your-client-secret
# MM_OAUTH_REDIRECT=http://127.0.0.1:7000/callback   # optional override
```

On first run the server opens a browser for the authorization-code + PKCE S256 flow. Tokens are
cached under `$XDG_CONFIG_HOME/mattermost-mcp` (or `~/.config/mattermost-mcp`) with `0600`
permissions and refreshed transparently thereafter.

> **Note:** Mattermost OAuth2 has no granular scopes — the token inherits the full access of the
> authorizing user.

## Tool Catalog

Legend: ⚠️ = write (blocked by `MM_READ_ONLY=true`) · 💥 = destructive (requires
`MM_ALLOW_DESTRUCTIVE=true` **and** `confirm: true` per call)

### Messaging (13)

| Tool                 | Description                                                                         |
| -------------------- | ----------------------------------------------------------------------------------- |
| `post_message` ⚠️    | Post a message to a channel (optional `root_id`, `file_ids`, `props`).              |
| `reply_thread` ⚠️    | Reply within a thread (`root_id`).                                                  |
| `get_channel_posts`  | Paginated channel history (`page`/`per_page`, or `since`/`before`/`after` cursors). |
| `get_thread`         | A root post and all its replies.                                                    |
| `get_post`           | A single post by id.                                                                |
| `search_posts`       | Full-text search within a team (`terms`, `is_or_search`).                           |
| `edit_post` ⚠️       | Update a post's message (patch — message field only).                               |
| `delete_post` 💥     | Delete a post.                                                                      |
| `send_dm` ⚠️         | Open/get a DM (2 users) or group DM (3–8 users) and post a message.                 |
| `pin_post` ⚠️        | Pin a post.                                                                         |
| `unpin_post` ⚠️      | Unpin a post.                                                                       |
| `add_reaction` ⚠️    | Add an emoji reaction (as the authenticated user).                                  |
| `remove_reaction` ⚠️ | Remove an emoji reaction.                                                           |

### Channels & Teams (12)

| Tool                   | Description                                     |
| ---------------------- | ----------------------------------------------- |
| `list_teams`           | Teams the authenticated user belongs to.        |
| `list_channels`        | The user's channels in a team.                  |
| `get_channel`          | Channel metadata.                               |
| `create_channel` ⚠️    | Create a public (`O`) or private (`P`) channel. |
| `join_channel` ⚠️      | Join a channel (self).                          |
| `leave_channel` ⚠️     | Leave a channel (self).                         |
| `archive_channel` 💥   | Archive (soft-delete) a channel.                |
| `list_channel_members` | Members of a channel (paginated).               |
| `add_member` ⚠️        | Add another user to a channel.                  |
| `remove_member` 💥     | Remove another user from a channel.             |
| `get_unreads`          | Per-channel unread/mention counts for a team.   |
| `mark_channel_read` ⚠️ | Mark a channel as viewed.                       |

### Users & Presence (6)

| Tool                   | Description                                          |
| ---------------------- | ---------------------------------------------------- |
| `get_me`               | The authenticated user.                              |
| `get_user`             | A user by id or username (exactly one required).     |
| `search_users`         | Search users by term.                                |
| `get_user_status`      | A user's status (`online`/`away`/`dnd`/`offline`).   |
| `set_status` ⚠️        | Set own status (`online \| away \| offline \| dnd`). |
| `set_custom_status` ⚠️ | Set own custom status (emoji + text).                |

### Files (3)

| Tool                | Description                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| `upload_file` ⚠️    | Upload a file to a channel (base64 content); returns file ids to attach via `post_message.file_ids`. |
| `get_file`          | Download a file's content as base64 (configurable `max_bytes` cap, default 8 MiB).                   |
| `get_file_metadata` | File info (`GET /files/{id}/info`).                                                                  |

## Guardrails

### Guardrail Variables

| Variable                    | Effect                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `MM_READ_ONLY=true`         | Every ⚠️ and 💥 tool hard-refuses at call time. Tools remain visible in `tools/list`. |
| `MM_ALLOW_DESTRUCTIVE=true` | Required to unlock the 💥 tools.                                                      |
| `MM_TEAM_ALLOWLIST`         | CSV of permitted team ids; calls targeting other teams are refused.                   |
| `MM_CHANNEL_ALLOWLIST`      | CSV of permitted channel ids; calls targeting other channels are refused.             |
| `MM_MAX_MESSAGE_LEN`        | Messages exceeding this length (Unicode code points) are rejected before sending.     |

### Rules

- Destructive tools (`delete_post`, `archive_channel`, `remove_member`) require **both**
  `MM_ALLOW_DESTRUCTIVE=true` in the environment **and** an explicit `confirm: true` argument in
  the tool call.
- `MM_READ_ONLY=true` takes precedence over `MM_ALLOW_DESTRUCTIVE`; all ⚠️/💥 tools refuse.
- Allowlists are checked against the resolved team/channel id for the call, not a display name.
- Mattermost API errors (status code + message) are surfaced verbatim — never swallowed.

## Register in an MCP Client

The server speaks MCP over **stdio**. Point your MCP client at the binary. Two ready-to-edit config
examples are in the `examples/` directory.

### After a global install + `login`

If you installed globally and ran `mattermost-mcp login`, the credentials are already on disk — the
client config needs no `env` block at all:

```json
{
  "mcpServers": {
    "mattermost": {
      "command": "mattermost-mcp"
    }
  }
}
```

### Generic (`examples/mcp.json`)

Suitable for any MCP client that follows the standard `mcpServers` schema (Cursor, Continue, etc.).
Copy to `.mcp.json` in your project root and adjust the path and credentials:

```json
{
  "mcpServers": {
    "mattermost": {
      "command": "node",
      "args": ["/absolute/path/to/mattermost-mcp/dist/index.js"],
      "env": {
        "MM_URL": "https://mattermost.example.com",
        "MM_AUTH_MODE": "pat",
        "MM_TOKEN": "your-personal-access-token"
      }
    }
  }
}
```

### Claude Desktop (`examples/claude_desktop_config.json`)

Merge into `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS (or the
equivalent path on Windows/Linux). **Always use absolute paths.** Restart Claude Desktop after
saving.

```json
{
  "mcpServers": {
    "mattermost": {
      "command": "node",
      "args": ["/absolute/path/to/mattermost-mcp/dist/index.js"],
      "env": {
        "MM_URL": "https://mattermost.example.com",
        "MM_AUTH_MODE": "pat",
        "MM_TOKEN": "your-personal-access-token"
      }
    }
  }
}
```

## Integration Testing

A `docker-compose.yml` ships in the repository. It starts a disposable Mattermost preview
instance:

```bash
docker compose up -d
# Mattermost is now running at http://localhost:8065
# Create an account + team, then generate a Personal Access Token.
```

Live integration tests are **skipped by default** (so `npm test` stays offline and green). Set
`MM_INTEGRATION=1` to enable them:

```bash
MM_INTEGRATION=1 \
  MM_URL=http://localhost:8065 \
  MM_AUTH_MODE=pat \
  MM_TOKEN=your-token \
  MM_TEST_CHANNEL_ID=<channel-id> \
  npm test
```

`MM_TEST_CHANNEL_ID` is optional; it only enables the post → get → delete write round-trip tests.

## Development

### Scripts

| Script           | Purpose                                                                     |
| ---------------- | --------------------------------------------------------------------------- |
| `npm run build`  | Compile TypeScript → `dist/`                                                |
| `npm run dev`    | Run the server from source over stdio (tsx, no build needed)                |
| `npm start`      | Run the built server (`node dist/index.js`)                                 |
| `npm test`       | Run the vitest suite (integration tests skipped without `MM_INTEGRATION=1`) |
| `npm run lint`   | ESLint + Prettier check                                                     |
| `npm run format` | Prettier write (auto-fix formatting)                                        |

## License

MIT
