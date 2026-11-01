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

## Rolling message cache

Set `MM_EVENTS_ENABLED=true` in the shared service to keep a local SQLite cache (Node.js **22.13+** with `node:sqlite`; the core MCP still supports Node 20). No OpenCode session, callback credential, or model is needed. The service opens an outbound Mattermost WebSocket as the configured account. The first connection and subsequent reconnects reconcile the most recent 48 hours of accessible history.

The cache contains text and identifiers from joined DMs, group DMs, private and public channels, including messages the account sent from other clients. It applies edits and deletes, omits system and burn-on-read posts, and does not copy file contents, embed previews or integration properties. Incoming means authored by someone else; outgoing means authored by this account. A mention is an explicit personal username in the message, not a broadcast or keyword notification.

Messages expire **48 hours after their original creation**, even if subsequently edited. Reads exclude expired rows immediately. Expired content is removed at startup, on reads/writes and every minute while the service is running. During downtime physical cleanup resumes at next start. Files are scoped by server, account and allowlists under `$XDG_STATE_HOME/mattermost-mcp/cache/` (default `~/.local/state/mattermost-mcp/cache/`); override the parent with `MM_EVENTS_STATE_DIR`. The DB is owner-only and contains private plaintext: retire obsolete scope files when changing accounts or guardrails. Cache pulls and callbacks recheck current channel access and fail closed if it cannot be verified.

## Pull or subscribe

| MCP tool                     | Contract                                                                                                                                                                                                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_cached_messages`       | Read immediately, newest first. Supply any combination of `channel_type` (D/G/O/P), `channel_id`, `sender_id`, `direction` (incoming/outgoing), `is_mention`, and a `since` creation time in epoch ms. Use `limit` (1–100, default 25) and `cursor` for further pages. |
| `subscribe_messages`         | Match **future** posts using the same filters except `since`; supply `ttl_seconds` (1–172800). When called from OpenCode, omit the destination to use the caller's session metadata. Otherwise supply one explicit `session_id` or allowed `callback_url`.             |
| `list_message_subscriptions` | List active registrations for this shared account and their expiry times.                                                                                                                                                                                              |
| `unsubscribe_messages`       | Pass `subscription_id` to cancel. Already accepted deliveries cannot be recalled.                                                                                                                                                                                      |

For a quick pull of your outgoing messages, call `list_cached_messages({"direction":"outgoing","limit":10})`. For mentions in one channel, combine `is_mention:true`, `direction:"incoming"` and its exact `channel_id`. Use `channel_type:"D"` and a verified `sender_id` for DMs from one person. Filters are ANDed; omit filters to include all qualifying posts. Cache queries return `{messages,nextCursor,syncState}` (a page may be incomplete while initial reconciliation is running) with bounded JSON; fetch the original post if a row reports truncation.

An OpenCode agent waiting for a reply can call:

```js
return await tools.mattermost.subscribe_messages({
  ttl_seconds: 1800,
  direction: "incoming",
  channel_type: "D",
  sender_id: "RESOLVED_MATTERMOST_USER_ID",
});
```

No polling or extra agent turn is needed while waiting. The service stores the registration, returns `subscriptionId` and `expiresAt` (epoch ms), and automatically expires it. Registering the same destination and filters renews the existing registration without replaying old posts. At most 64 registrations are active. These local writes are blocked by `MM_READ_ONLY=true`. All holders of the shared MCP bearer have the same account-level access to registered subscriptions.

## Enable callback destinations

- **OpenCode:** configure `MM_OPENCODE_URL` (loopback HTTP origin) and `MM_OPENCODE_PASSWORD_FILE` (private service password). These authorize an adapter; they do **not** choose or wake any session. The registered destination is `/api/session/{sessionID}/synthetic` and uses queued, resumable delivery. OpenCode v2 supplies its caller session in MCP request metadata. If a client does not supply it, pass an exact session ID or callback URL. Never guess the last active session.
- **Other agents:** set `MM_CALLBACK_TARGETS_FILE` to a private JSON file listing exact approved callback URLs, for example `[{"url":"https://agent.example/hooks/mattermost","bearer_file":"/private/hook-token"}]`. The bearer file is optional. Use HTTPS or loopback HTTP; redirects, embedded credentials, query strings and fragments are rejected. The MCP caller cannot supply a credential or invent an arbitrary network destination.

Callbacks carry **metadata only**: subscription, post, channel, sender and thread-root IDs, direction, channel type, mention flag and creation time. Pull the cached text or call `get_post` on demand. A webhook must return HTTP 2xx and should deduplicate its `Idempotency-Key`; OpenCode uses a stable synthetic input ID. An unacknowledged delivery is retried until the lease expires; a successful delivery advances its persistent cursor. While delivery is retrying, the subscription list includes `deliveryFailures` and `retryAt`. Only eligible posts still available in the rolling cache can be delivered. A notification never authorizes an automatic reply.

**Upgrading from 0.6:** remove `MM_OPENCODE_SESSION_ID`. No legacy inbox/outbox deliveries are imported or replayed. With zero registrations, the service only caches messages.
