# mattermost-mcp

A Node.js 20 / TypeScript MCP server over **stdio** that wraps the official
[`@mattermost/client`](https://github.com/mattermost/mattermost/tree/master/webapp/packages/client)
Client4 (REST v4). It authenticates to a **self-hosted** Mattermost instance and exposes
**34 tools** across messaging, channels/teams, users/presence, and file operations. Safe-by-default
via a configurable guardrail layer; all output goes to stdout (the MCP channel) and all logging goes
to stderr.

This is [difof's fork](https://github.com/difof/mattermost-mcp) of
[BryanBerger98/mattermost-mcp](https://github.com/BryanBerger98/mattermost-mcp), with fixes for
personal-account automation. It targets Mattermost servers exposing REST API v4.

## Features

- **3 authentication modes** — Personal Access Token (default), username/password (+MFA), OAuth2
  (authorization-code + PKCE S256 with transparent token refresh).
- **34 tools** across 4 domains — messaging (13), channels & teams (12), users & presence (6),
  files (3).
- **Safe by default** — read-only mode (`MM_READ_ONLY`), destructive-action gate
  (`MM_ALLOW_DESTRUCTIVE`), team/channel allowlists, and per-call `confirm: true` requirement for
  destructive tools.
- **Resilience** — configurable request timeout, with exponential back-off + jitter for safe reads
  on `429` / `5xx` / network errors. Mutations are not automatically repeated after ambiguous failures.
- **Strict validation** — every tool input is validated with a Zod schema before any API call.
  Mattermost errors are surfaced verbatim (status code + message).

## Requirements

- Node.js ≥ 20
- A self-hosted Mattermost server with a user account and credentials (PAT, login/password, or an
  OAuth2 application)

## Install

### Build this fork

```bash
git clone --branch master https://github.com/difof/mattermost-mcp.git
cd mattermost-mcp
npm ci
npm run build
node dist/index.js login    # interactive: server URL + auth, saved to the config dir
node dist/index.js status   # verify: prints the authenticated identity
```

`login` validates the credentials against the server and writes them (0600) under
`$XDG_CONFIG_HOME/mattermost-mcp` (or `~/.config/mattermost-mcp`). The MCP server then picks them up
automatically — no env vars required. See [CLI](#cli) and [Authenticate with `login`](#authenticate-with-login).

For a global `mattermost-mcp` command, link the built checkout:

```bash
npm link
```

The npm package `@bryanberger/mattermost-mcp` is published by upstream. Use the source checkout
above for this fork's fixes; its inherited release workflow is disabled outside the upstream repository.

## CLI

The `mattermost-mcp` binary is both the MCP server and a small management CLI:

| Command                         | Description                                                             |
| ------------------------------- | ----------------------------------------------------------------------- |
| `mattermost-mcp`                | Start the MCP server on stdio (default — this is what MCP clients run). |
| `mattermost-mcp login`          | Interactive auth wizard; validates and saves credentials.               |
| `mattermost-mcp login --gitlab` | Browser SSO login (GitLab/SAML) — no admin or PAT required.             |
| `mattermost-mcp status`         | Authenticate with the resolved config and print the current identity.   |
| `mattermost-mcp logout`         | Remove saved credentials (and the matching OAuth token cache).          |
| `mattermost-mcp --help`         | Usage. `--version` prints the version.                                  |

## Authenticate with `login`

```text
$ mattermost-mcp login
Mattermost server URL (e.g. https://mm.example.com): https://mattermost.example.com
Authentication mode (↑/↓ to move, Enter to select):
› pat           paste a Personal Access Token
  password      username/email + password (+ MFA)
  oauth2        OAuth2 app + browser consent
  gitlab / SSO  browser login via GitLab/SAML — no admin
Personal Access Token: ********
✓ Logged in as @alice on https://mattermost.example.com
  Saved to ~/.config/mattermost-mcp/credentials.json (mode: pat, 0600)
```

The mode picker is keyboard-navigable (arrow keys / `j`·`k`, digits to jump, Enter to confirm). When
input is not a TTY it falls back to a numbered prompt.

- **pat** — saves the token as-is.
- **password** — exchanges your password for a **session token** and saves _that_ (the password is
  never written to disk); re-run `login` when the session expires.
- **oauth2** — runs the browser consent flow and caches the OAuth tokens (refreshed transparently).
- **gitlab / SSO** — see below; also selectable directly with `mattermost-mcp login --gitlab`.

### Browser SSO login (GitLab / SAML)

If your server's only login is an external IdP (e.g. GitLab) **and you are not an admin**, both PATs
and OAuth2 apps may be unavailable — they require server settings only an admin can enable. Use the
browser SSO login instead:

```text
$ mattermost-mcp login --gitlab
Mattermost server URL: https://mattermost.example.com
Opening a browser window. Complete the GitLab (or other SSO) login there.
✓ Logged in as @alice on https://mattermost.example.com
  Saved to ~/.config/mattermost-mcp/credentials.json (mode: pat — browser SSO session token, 0600)
```

It opens a browser at `{server}/login`, waits while you complete the SSO login in that window, then
reads the resulting `MMAUTHTOKEN` session cookie and saves it as a token. The flag is
provider-agnostic (`--sso` is an alias), and `gitlab / SSO` is also offered in the `login` menu.

- Uses your **default browser** when it is Chromium-based (Chrome, Chromium, Brave, Edge, Opera,
  Vivaldi, Arc, Dia…); otherwise the first installed Chromium engine it finds. Override with
  `MM_CHROME_PATH=/path/to/browser` (puppeteer-core can only drive Chromium engines — not Safari or
  Firefox).
- The captured token is a **session token** — it expires with the server's SSO session length. Re-run
  `mattermost-mcp login --gitlab` when calls start returning `401`.
- Cleanest long-term fix: ask an admin to enable Personal Access Tokens, then use `login` (pat).

## Configuration

Credentials come from two sources, in order of precedence:

1. **Environment variables** (`MM_*`) — always win; ideal for CI and the `examples/` MCP client configs.
2. **Saved `login` credentials** — the baseline when the matching env vars are absent.

Blank environment values count as unset. Saved credentials are tied to their server URL: changing
`MM_URL` to a different origin or subpath requires credentials for that server instead of reusing the
saved token or password.

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

| Variable                | Required | Default | Description                                                                             |
| ----------------------- | -------- | ------- | --------------------------------------------------------------------------------------- |
| `MM_REQUEST_TIMEOUT_MS` | no       | `30000` | Per-request timeout in ms (`0` disables).                                               |
| `MM_MAX_RETRIES`        | no       | `3`     | Safe-read retries on `429` / `5xx` / network errors with exponential back-off + jitter. |
| `MM_RETRY_BASE_MS`      | no       | `500`   | Back-off base delay in ms.                                                              |

Retries apply to individual GET/HEAD/OPTIONS requests and the verified read-only user/post search
endpoints. Other POST/PUT/DELETE requests are attempted once on transient failures, preventing
automatic duplicate sends after a lost response. Password/OAuth authentication can still recover
from a rejected `401` and retry that individual request. A timeout or lost response to a write means
its outcome is unknown; check the conversation before sending the same message again.

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

For `get_channel_posts`, `before` and `after` are mutually exclusive. `since` retrieves modified posts
and cannot be combined with either cursor or `page`/`per_page`; the server caps that response at
1,000 posts, so use paginated history for a complete backfill. For `send_dm`, supply only distinct
IDs of the other participants (one for a DM, two to seven for a group).

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

`get_unreads` returns the server's unread counts, not the membership's already-read message
baseline. It makes one membership request plus one unread-count request per permitted channel.

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
- Allowlists apply to resolved channel/team IDs, including post IDs, file IDs, and attachments.
  Team/channel listings and post searches filter their results accordingly.
- With an allowlist configured, post responses omit permalink preview metadata, which can contain
  another channel's full message. The original message text and links remain available.
- A channel allowlist blocks `create_channel` and `send_dm`, since they open a channel before its ID
  can be checked. Send to an existing permitted DM/group channel with `post_message` instead.
- DMs/group DMs have no team and are excluded by a team allowlist. Use a channel allowlist to
  restrict access to selected existing conversations.
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
