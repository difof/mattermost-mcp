# Multiple accounts and authenticated consumers

The shared HTTP service can manage several verified Mattermost accounts in one process.
Every account has its own client, WebSocket/recovery loop, guardrails, cache scope and subscriptions.
A failed account does not make another account's credentials available or stop healthy accounts.

## Initialize once

Use Node.js 22.13+ for the account registry and message cache. Set `MM_ACCOUNTS_FILE` to an
absolute owner-only JSON seed file. Its shape is:

```json
{
  "default_account_id": "operator",
  "accounts": [
    {
      "id": "operator",
      "label": "Operator",
      "url": "https://chat.example",
      "token": "SYNTHETIC_OPERATOR_PAT"
    },
    {
      "id": "assistant",
      "label": "Assistant",
      "url": "https://chat.example",
      "token": "SYNTHETIC_ASSISTANT_PAT"
    }
  ]
}
```

Real secrets belong only in the private runtime file. Instead of `token`, use `token_file`
with an absolute private file and optional one-based `token_line`. Each entry accepts an
optional `options` object containing the documented account-level `MM_*` guard/cache/request
settings. IDs are immutable ASCII identifiers up to 64 characters; labels are editable.

The service verifies every seed identity, then commits the account list and initialization
marker transactionally. Duplicate server/user identities are rejected. A failed seed remains
retryable. On later starts, it reads the account registry, not the seed or legacy PAT values.
Removing/changing the seed cannot replace configured credentials or restore disabled accounts.

`MM_ACCOUNTS_DB` optionally selects an absolute registry database path; its default is
`accounts.sqlite3` under the configured event-state directory. Protect the database and its
sidecars as credentials. No token is returned by account discovery or management.

Existing cache files retain their server/user/access-policy hash and data. Post ordering,
unread counts and subscriptions are not reset. The registry is a separate SQLite database:
this release deliberately does **not** consolidate old cache files. Existing non-secret
settings are imported once for the explicit default (or sole) account; other accounts start
with their own configured defaults and separate settings files. Callback destinations
and HTTP credentials retain the existing private service configuration/reload model.

Without multi-account configuration, legacy stdio and shared-service authentication remain
available. Multi-account lifecycle/listener ownership is implemented by `serve`; standalone
`login/status/logout` still manage the legacy saved login, not the service registry.

## Select an account

Call `list_accounts({})` for verified account IDs, usernames, enabled state and health.
Every ordinary account operation accepts `account_id`. Explicit selection is pinned before
guardrails, resource checks, retries and I/O.

With one configured account, omission selects that account. With multiple accounts, omission
fails unless the seed explicitly configured `default_account_id`. This optional operator
default preserves older clients. An invalid, disabled or unavailable supplied account never
falls back. New consumers should always select explicitly.

All holders of the ordinary HTTP bearer can operate configured accounts within their
guardrails. Account selection is routing, not a new caller authorization boundary; use
separate service credentials/processes for separate trust domains.

The separate admin endpoint provides:

- `list_accounts`: registry revision and safe account status.
- `add_account({source_file, expected_revision?})`: verify a private single-account JSON input.
- `update_account({account_id, label?, enabled?, expected_revision?})`: update label or lifecycle.
- `rotate_account({account_id, source_file, expected_revision?})`: verify the same URL/user before replacing a token.
- Existing settings tools accept `account_id`; account settings remain separately scoped.

Source files use one account object from the seed shape. Never put credentials in MCP
arguments. The registry revision prevents stale account edits. Disabling closes only that
account's listeners and makes its selector unavailable. A rejected rotation preserves the
working credential. Added credential input paths are excluded from existing account uploads.

## Subscribe a generic consumer

Configure an exact callback target using the existing private target file:

```json
[
  {
    "url": "https://consumer.example/events",
    "bearer_file": "/absolute/private/consumer-token",
    "receipt": true,
    "template": "Account {{accountId}} received {{eventType}} post {{postId}}."
  }
]
```

Only HTTPS or literal-loopback HTTP is accepted; redirects are never followed. Durable
receipt mode requires a private bearer. Legacy webhook targets still accept successful
HTTP responses without a receipt unless they explicitly enable `receipt`.

Register through ordinary MCP:

```js
subscribe_messages({
  account_id: "assistant",
  persistent: true,
  direction: "incoming",
  channel_type: "D",
  callback_url: "https://consumer.example/events",
});
```

Use either `persistent:true` or a finite `ttl_seconds` (1–172800). A permanent registration
returns `persistent:true, expiresAt:null` and survives restart until cancelled. The account,
target and complete filters define its identity. Registration starts at the current cache
watermark; it does not replay all retained history. No sender filter means any sender.

Callbacks contain `id`, `type:"mattermost.message"`, `accountId`, `eventId`,
`eventType:"posted"`, `subscriptionId`, `postId`, `channelId`, `senderId`, `rootId`,
`createdAt`, `channelType`, `direction`, `isMention`, `text` and `templateRevision`.
The sender comes from the authenticated Mattermost post, not an untrusted display name.
The default text is metadata-only. Read the selected account's post when content is needed.

The consumer persists the delivery before acknowledging with
`{"id":"THE_RECEIVED_ID","accepted":true}`. Duplicates must return the same receipt.
The service retries an uncertain or wrong receipt with the same ID and pinned payload.
Successful admission is not proof of completed consumer work or exactly-once external effects.

Templates use Mustache scalar fields from the callback plus optional `message`. Sections,
partials, lambdas, unknown/missing fields and oversized output are rejected. Message content
is rendered once as data. Trusted identity metadata is serialized separately and cannot be
overridden by template text. Pending deliveries pin rendered payload/revision before I/O;
changing a template does not change an uncertain retry.

New subscriptions exclude known MCP-origin outgoing posts unless
`include_service_outgoing:true`. Incoming posts sent by another controlled account remain
eligible. Convenience sends and the standard create-post API track send intents/receipts;
other clients and unrecognized indirect sends have unknown origin, not proven human origin.
This does not prevent two independent consumers from replying to each other: consumers own
their authorization, correlation and loop policy.

Posts, pending callback bodies and send-origin records use the configured retention window,
48 hours by default. Permanent registration does not extend content retention. Edits/deletes
update the existing cache but do not create separate callback events in this release.

## Typing and interaction

`publish_typing({account_id, channel_id, parent_id?})` verifies account/channel membership,
resource allowlists and write guards, then publishes one transient typing pulse. The consumer
controls short active-work pulses and must stop on completion, denial, cancellation or waits.
Pulses are not queued or replayed.

`post_message` already supports custom `props` for interactive posts. Use the catalogued
dialog operation with a real Mattermost trigger when needed. Callback authorization, one-use
approval records, model selection and business workflows remain entirely in the consumer.
