# One service for multiple MCP clients

Run `mattermost-mcp serve` to share one authenticated Mattermost account and its guardrails.
It serves stateless Streamable HTTP at `http://127.0.0.1:8766/mcp`. The default CLI still
speaks stdio. All clients of the shared service get the same account, permissions and
server-side upload roots: use separate services for distinct trust boundaries.

## Set up the service

1. Build the checkout. Use the existing saved login or start the service through a wrapper
   that sets the existing Mattermost credentials. Keep the PAT on the server.
2. Generate a **separate** HTTP bearer with a cryptographic random generator (for example
   `openssl rand -hex 32` written directly to a private file with `umask 077`). Set
   `MM_HTTP_TOKEN_FILE` to its absolute path. Alternatively set `MM_HTTP_TOKEN`; never both.
3. Run one supervised instance. The [systemd user unit](../examples/mattermost-mcp.service)
   assumes a launcher at `~/.local/bin/mattermost-mcp`. Adapt its absolute executable to the
   local install; put settings in `~/.config/mattermost-mcp/service.env` (0600).
   Install the unit in `~/.config/systemd/user/` and run `systemctl --user daemon-reload`,
   then `systemctl --user enable --now mattermost-mcp.service`.

Configure OpenCode v2's existing server name in place, leaving its Code Mode setting unchanged:

```json
{
  "mcp": {
    "servers": {
      "mattermost": {
        "type": "remote",
        "url": "http://127.0.0.1:8766/mcp",
        "oauth": false,
        "headers": { "Authorization": "Bearer {file:~/.local/share/mattermost-mcp/http-token}" }
      }
    }
  }
}
```

Every request requires the HTTP bearer. Use MCP initialize and tools/list to test; ordinary
GETs are not health checks. The service only binds IPv4 loopback and validates Host and Origin.
`MM_HTTP_PORT` defaults to 8766. `MM_HTTP_MAX_BODY_BYTES` defaults to 4 MiB (up to 256 MiB);
this bounds the JSON envelope, separately from the upload limit for server-local file paths.

## Incoming DMs and personal mentions

Enable this only in the shared service, not in each client. No inbound Mattermost webhook,
public endpoint or periodic model prompt is needed. Set:

| Variable                    | Value                                                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `MM_EVENTS_ENABLED`         | `true` (default `false`)                                                                                         |
| `MM_OPENCODE_URL`           | OpenCode service loopback HTTP origin, default `http://127.0.0.1:4096`                                           |
| `MM_OPENCODE_SESSION_ID`    | One existing, explicitly chosen inbox session                                                                    |
| `MM_OPENCODE_PASSWORD_FILE` | Owner-only private file containing the OpenCode service password                                                 |
| `MM_EVENTS_STATE_DIR`       | Optional absolute private directory; default `$XDG_STATE_HOME/mattermost-mcp` or `~/.local/state/mattermost-mcp` |

The account opens an outbound WebSocket and listens for new one-to-one DMs from others
and explicit personal mentions in joined channels or groups. Own posts, system notices and
broadcast-only mentions are ignored. The service sends IDs and the event type to the session's
`/synthetic` endpoint with `delivery: "queue"` and `resume: true`. An idle inbox wakes;
a busy one can finish its current work. The notification never authorizes a reply or an
action requested by a correspondent. For a notification-only inbox, use session permissions
to deny all tools except Code Mode and specifically required read tools (e.g. `mattermost_get_post`).

First launch starts at the current time. After a disconnect or process restart, the listener
reconciles retained, accessible history from a checkpoint with overlap. Live events require
Mattermost's recipient mention flag as well as the username; REST recovery uses the current
unmodified text because the original mention flags aren't retained. Deleted/inaccessible
posts and original mentions in edited channel posts cannot be reconstructed. Backfilled events
may arrive out of posting order.

Pending ID-only notifications survive OpenCode outages and restart. Stable input IDs allow
safe retries after an uncertain acknowledgement. No post bodies or credentials are stored in
the outbox. State is scoped by Mattermost server/account, guardrails and destination session;
changing scope starts a fresh checkpoint. Preserve state across upgrades. At 10,000 pending
notifications intake applies backpressure instead of evicting notifications. Restore the
destination if delivery is stalled and monitor the service journal for reconnects and retries.
