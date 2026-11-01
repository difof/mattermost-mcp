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
3. On Linux, put service settings in `$XDG_CONFIG_HOME/mattermost-mcp/service.env`
   (default `~/.config/mattermost-mcp/service.env`, mode 0600). From the built checkout:

   ```bash
   node scripts/install-service.mjs --print
   node scripts/install-service.mjs
   systemctl --user daemon-reload
   systemctl --user enable --now mattermost-mcp.service
   ```

The [installer](../scripts/install-service.mjs) renders the [unit template](../examples/mattermost-mcp.service.in)
using the current Node executable and this checkout's built entry. The resulting machine-specific
paths live only in the installed unit, under `$XDG_CONFIG_HOME/systemd/user/`. Keep the checkout
in a stable location. The installer never reads credential values, changes the environment file
or controls the running service.

If an existing executable wrapper supplies credentials, pass `--launcher /absolute/path/to/wrapper`;
it receives the single argument `serve`. Alternatively use `--node PATH --entry PATH`.
Use `--env-file PATH` to choose a different private file, or `--no-env-file` when the launcher
already supplies **all** required variables. Preview with the same flags plus `--print`.
A matching unit is left alone. To update a differing regular unit, review the preview,
rerun with `--replace`, then run `daemon-reload`. Restart an already running unit explicitly
when its launch command or environment changes.

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

To inspect and change the running service, configure the separate [admin connection](admin-settings.md). It is optional and does not add tools to ordinary clients.

## Rolling message cache

Set `MM_EVENTS_ENABLED=true` in the shared service to keep a local SQLite cache (Node.js **22.13+** with `node:sqlite`; the core MCP still supports Node 20). No OpenCode session, callback credential, or model is needed. The service opens an outbound Mattermost WebSocket as the configured account. After a shutdown or lost connection, the next connection pages retained Mattermost history across joined, permitted channels for the full configured retention window (48 hours by default). This recovers missed incoming and sent posts, reconciles edits, and removes locally cached posts that were deleted upstream. Use `syncState` on cache pulls to check progress. `recovering` means replay is still running. `partial` means one or more channels failed temporarily, or at least 200 posts shared a creation millisecond and Mattermost could not provide a stable cursor through them. The service makes a best-effort pass, continues live events and other channels, and retries the window on a later reconnect. Do not treat an absent row as proof of absence while partial: fetch by exact post ID if known. `connected` means the replay completed. Posts outside the window, deleted before they could be fetched, or no longer accessible cannot be recovered.

The cache contains text and identifiers from joined DMs, group DMs, private and public channels, including messages the account sent from other clients. It applies edits and deletes, omits system and burn-on-read posts, and does not copy file contents, embed previews or integration properties. Incoming means authored by someone else; outgoing means authored by this account. A mention is an explicit personal username in the message, not a broadcast or keyword notification.

Messages expire based on their **original creation time**, even if subsequently edited. Set the startup default with `MM_RETENTION_HOURS` (1–168, default 48), or change `retention_hours` live through the [admin tools](admin-settings.md#list-set-reload). Reads exclude expired rows immediately. Expired content is removed at startup, on reads/writes and every minute while caching is enabled. During downtime physical cleanup resumes at next start. Files are scoped by server, account and allowlists under `$XDG_STATE_HOME/mattermost-mcp/cache/` (default `~/.local/state/mattermost-mcp/cache/`); override the parent with `MM_EVENTS_STATE_DIR`. The DB is owner-only and contains private plaintext: retire obsolete scope files when changing accounts or resource allowlists. Before returning a page or sending callback metadata, the service rechecks membership and verifies permission to read posts in the candidate channels. A definitive denial purges that channel locally. A temporary verification failure returns no page or callback and retains the rows for a later retry.

## Local account and conversation directory

`list_cached_conversations` returns the account ID and username alongside a page of joined conversations. For DMs, use `channel_type: "D"`; for group DMs use `"G"`. A DM peer ID can be matched to an exact user. Follow `nextCursor` with the same filters to list them all. This directory is independent of post retention: an old or hidden DM can still be listed. Membership alone does not establish that a conversation contains a post.

The service reconciles directory metadata with Mattermost on startup and reconnect and refreshes it on relevant account, channel and membership events. A fresh directory lookup verifies account and memberships before querying SQLite. Continuation cursors may briefly reuse a verified snapshot (up to three seconds) while the stream is healthy. Membership changes invalidate that snapshot; disconnected or dirty continuations revalidate. If that fails, the tool returns an error instead of stale names. Mattermost streams memberships in a single response; the service rejects an incomplete response or one larger than 8 MiB. A specific retired cache can be maintained offline using `node dist/index.js prune-cache --state-dir /absolute/state-directory --scope EXACT_64_HEX_SCOPE --retention-hours 48`. Choose the scope and retention deliberately; stop its owning process first. This command does not scan for accounts, remove memberships or print message content. While every process is stopped, physical expiry waits for the next service start or explicit maintenance.

The directory contains no post bodies. Inbox pulls separately verify permission to read channel content.

For exact routing, use `resolve_conversation({username:"exact.name"})` or `resolve_conversation({channel_name:"alerts",team_id:"EXACT_TEAM_ID"})`. An ambiguous result contains candidates, not a selected recipient. The tool does not create a DM or join a channel. Use `get_inbox_status({})` to inspect replay state, checkpoint, and partial-channel counts without pulling posts. `include_counts:true` requests retained and unread totals after content authorization. With strict per-post verification enabled, optional totals are unavailable; status without counts remains available.

## Pull or subscribe

For an inbox pull that can safely be retried after a lost response, pass a fresh UUID as `request_id`. Within ten minutes, reuse it with exactly the same filters, cursor, page size and harness session. The original selection and issuance counts are reused without a second increment. The response is reauthorized and rendered from **current** rows: changed text may differ; expired, removed or reinserted rows are omitted. If the previous cursor boundary disappears, `cursorInvalidated:true` means start a fresh request. Receipts store references only, up to 1,024 outstanding per cache. A full receipt store rejects a new keyed request before consuming any posts. Use a new UUID for each new page. After expiration the UUID no longer deduplicates.

Missed history is retried independently per channel. `partial` can mean a temporary per-channel failure or an ambiguous timestamp boundary. A temporary callback permission failure holds that channel's lease; other verified leases may still deliver. A failed account-wide identity or membership check blocks all affected disclosures.

Every returned inbox post has a shared `readCount`. It starts at zero and includes the current pull: the first response shows `1`, the next `2`. Use `{"unread_only":true}` to claim posts no previous inbox pull has returned. Concurrent unread-only pulls do not claim the same post. Edits and restarts preserve the count for a retained post; existing cache rows start at zero on upgrade. Expiry or removal of the row discards its count.

The count records newly issued tool results; without a retry key a repeated pull counts again. It does not identify agents, confirm a human saw a post, or change Mattermost unread state. Backfill, directory queries, callbacks and direct Mattermost history tools do not increment it.

| MCP tool                     | Contract                                                                                                                                                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_cached_messages`       | Read immediately, newest first. Supply any combination of `channel_type` (D/G/O/P), `channel_id`, `sender_id`, `direction` (incoming/outgoing), `is_mention`, and a `since` creation time in epoch ms. Use `limit` (1–100, default 25) and `cursor` for further pages.               |
| `subscribe_messages`         | Match **future** posts using the same message filters except `since` and `unread_only`; supply `ttl_seconds` (1–172800). When called from OpenCode, omit the destination to use the caller's session metadata. Otherwise supply one explicit `session_id` or allowed `callback_url`. |
| `list_message_subscriptions` | List active registrations for this shared account and their expiry times.                                                                                                                                                                                                            |
| `unsubscribe_messages`       | Pass `subscription_id` to cancel. Already accepted deliveries cannot be recalled.                                                                                                                                                                                                    |

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
