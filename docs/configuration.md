# Configuration and authentication

[Back to README](../README.md) · [Tool reference](tools.md)

## CLI

Run `npm link` in the built checkout for the `mattermost-mcp` command, or replace it below with
`node /absolute/path/to/mattermost-mcp/dist/index.js`. The same binary starts the MCP server and
provides these management commands:

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

1. **Environment variables** (`MM_*`) — always win; ideal for CI and the [example MCP client config](../examples/mcp.json).
2. **Saved `login` credentials** — the baseline when the matching env vars are absent.

Blank environment values count as unset. Saved credentials are tied to their server URL: changing
`MM_URL` to a different origin or subpath requires credentials for that server instead of reusing the
saved token or password.

In development you can place env vars in a `.env` file in the project root and export them before
running; in production pass them directly to the process. The [`.env.example`](../.env.example) lists every setting. The server does not load `.env` automatically; export those variables or pass them in your MCP client configuration.

### Environment Variables

#### Connection

| Variable | Required | Default | Description                                                                               |
| -------- | -------- | ------- | ----------------------------------------------------------------------------------------- |
| `MM_URL` | **yes**  | —       | Server root URL, no trailing slash, no `/api/v4` (e.g. `https://mattermost.example.com`). |

#### Authentication

| Variable            | Required        | Default                          | Description                                                                                                                                                |
| ------------------- | --------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MM_AUTH_MODE`      | no              | `pat`                            | One of `pat \| password \| oauth2`.                                                                                                                        |
| `MM_TOKEN`          | when `pat`      | —                                | Personal Access Token sent as a Bearer token. Create it under Profile → Security → Personal Access Tokens after your administrator enables token creation. |
| `MM_LOGIN_ID`       | when `password` | —                                | Username or email.                                                                                                                                         |
| `MM_PASSWORD`       | when `password` | —                                | Password.                                                                                                                                                  |
| `MM_MFA_TOKEN`      | no              | —                                | MFA one-time code (only if the account enforces MFA).                                                                                                      |
| `MM_CLIENT_ID`      | when `oauth2`   | —                                | OAuth2 app client id (register in System Console → Integrations → OAuth 2.0 Applications).                                                                 |
| `MM_CLIENT_SECRET`  | when `oauth2`   | —                                | OAuth2 app client secret.                                                                                                                                  |
| `MM_OAUTH_REDIRECT` | no              | `http://127.0.0.1:7000/callback` | Loopback redirect URI (must start with `http://` or `https://`).                                                                                           |

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

After your administrator enables PATs and grants your account permission to create them, create a token under **Profile → Security → Personal Access Tokens**, then:

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

## Guardrails

### Controls

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

## PAT permissions

A PAT acts as its account. It can access the conversations that account may access, subject to
server roles, channel membership, licenses and enabled features. It does not independently grant
admin privileges or access to someone else's private messages. See the official
[personal access token reference](https://docs.mattermost.com/developers/integrate/reference/personal-access-token)
and this fork's [API coverage audit](api-coverage.md).
