# Mattermost multi-account implementation plan

Status: proposed architecture; feature implementation pending.

This document describes reusable implementation contracts and acceptance criteria. Keep
operator-specific deployment observations and live-test evidence outside version control.

## Goal and boundaries

One service manages a configured list of Mattermost accounts: authenticated API calls,
sending/receiving messages, account-specific caches, and opt-in event delivery to existing
OpenCode sessions. An agent can subscribe its current session to every incoming DM for one
account and resume when a matching event arrives.

Sender-dependent decisions belong to that OpenCode session's instructions. Deliver verified
sender/account IDs; do not hardcode company hierarchy, execute business workflows, or infer
authority from display names. Keep native JavaScript ESM and `node:sqlite`; the conditional
GoJet request does not apply. No language rewrite, extra broker, or workflow framework.

## P0 — establish the baseline

- [ ] Inspect current source, configuration, schema and Git state before migration work.
- [ ] Verify health without consuming existing unread messages; keep deployment details private.
- [ ] Run offline checks and fix reproducible defects with synthetic regression coverage.
- [ ] Identify legacy import requirements and supported callback contracts from source and API schemas.

The current implementation has one authenticated account per runtime, JSON settings overrides,
inline SQLite schema updates, scoped post/directory caches and persistent timed subscriptions.
Message callbacks cover new posts; edits/deletes update snapshots. Account selection, permanent
subscriptions, versioned migrations and database-authoritative configuration remain to be built.

Relevant owners: [runtime](../src/service/runtime.js),
[tool dispatch](../src/tools/registry.js), [cache](../src/events/cache.js),
[subscription storage](../src/events/subscription-store.js),
[delivery](../src/events/subscriptions.js), [callbacks](../src/events/callbacks.js),
[tests](testing.md), [service contract](shared-service.md).

## Contracts to preserve across phases

### One authoritative database

Use one owner-only SQLite database for settings, account credentials, account/scoped caches,
directories, event records, subscriptions and delivery progress. The seed file may contain an
account list with server URL and either a PAT or an absolute token-file input. Resolve file
inputs during initialization and persist the resulting credentials privately in SQLite.

The seed is read only for an uninitialized database. Commit configuration and an initialization
marker together; a failed seed must leave initialization retryable. Editing/removing the seed or
changing legacy environment settings must not alter a configured database. An empty account
list or a failed login must not trigger reseeding.

Only the database locator and explicit bootstrap/maintenance controls stay outside SQLite.
Later account additions, login, rotation, settings changes and imports are explicit operations.
Settings reset to a stored baseline, never to newly changed seed/environment values. Keep
revision conflict checks and validated activation/rollback.

Apply this consistently to `serve`, stdio, login, status, logout and maintenance. Raise the
runtime requirement to Node 22.13+ for native SQLite; keep help/version lazy. Only the shared
service owns listener/delivery workers; stdio and maintenance must not start competing workers.

Protect the DB, WAL/SHM/journal sidecars, seed and credential inputs from uploads and logs.
Persist PAT/session/refresh credentials as needed, never plaintext login passwords. Management
responses expose configuration and credential status, not secret values. Retain the separate
admin authentication boundary and the existing shared-client trust model; account selection
alone is not a new authorization boundary.

### Account identity and routing

A configured `account_id` is immutable and resolves to a verified canonical server URL plus
Mattermost user ID. A label may change. Token rotation must verify the same identity before
activation; another user requires another account. Reject duplicate verified identities unless
a later explicit design decision explains their semantics.

Resolve an account before guardrails, resource checks or network calls, then pin it for the
entire request/retry. With multiple configured accounts, omission is an error; a sole configured
account may retain existing no-selector behavior. Never silently switch to another account when
the chosen account is disabled or unhealthy. No mutable global current-account setting.

Account/access scope qualifies posts, directory entries, recovery checkpoints, subscriptions,
cursors, inbox receipts and events. The same DM post seen by two accounts has opposite direction
and independent read counts. IDs from different servers cannot collide. Preserve membership
generation fencing and fresh disclosure checks; stale replay must not restore revoked content.

### Event and delivery semantics

Keep current message snapshots separate from a bounded durable event journal. Initially support
`posted`, `edited` and `deleted`; default existing message subscriptions to `posted`.
Other Mattermost events may maintain cache/directory health, but presence/typing/reactions do not
become notification features implicitly.

Define deterministic event identity using account, post, event kind and revision; an edit cannot
reuse the original posted-event delivery ID. Atomically persist snapshot changes and events.
Handle duplicate/reordered WebSocket frames and reconciliation. Recovery may discover the latest
state, but cannot reconstruct every intermediate edit or a post deleted before observation.

Use stable delivery IDs per subscription/event, persisted before network I/O. Preserve legacy
IDs for uncertain deliveries during import. OpenCode delivery remains:

```json
{
  "id": "msg_<stable_delivery_id>",
  "delivery": "queue",
  "resume": true,
  "description": "Subscribed Mattermost event",
  "text": "<notification with account_id and post_id>",
  "metadata": {
    "source": "mattermost",
    "mattermost": {
      "accountId": "<configured_account_id>",
      "eventId": "<stable_event_id>",
      "eventType": "posted",
      "postId": "<post_id>",
      "channelId": "<channel_id>",
      "senderId": "<verified_user_id>",
      "direction": "incoming"
    }
  }
}
```

Use `POST /api/session/{sessionID}/synthetic`, not a guessed prompt endpoint. Check response
ID, session and type before acknowledging delivery. Retry uncertain admission with the same ID.
A receipt proves admission, not completed agent work or exactly-once external side effects.
Queue into busy sessions; do not interrupt them or wait for an idle poll. Never select an
unrelated session. Callback text must specify the same account for subsequent tool calls.

### Subscription lifetime and outgoing origin

Add an explicit permanent mode, mutually exclusive with `ttl_seconds`. Permanent subscriptions
survive restarts until cancelled/disabled; imported timed leases retain their existing expiry.
Renewal remains idempotent for the same account, destination and filters. Preserve automatic
attachment using `_meta["ai.opencode/sessionID"]`; explicit destinations retain precedence.

Proposed ordinary call, to finalize in P3/P5:

```js
subscribe_messages({
  account_id: "work-assistant",
  persistent: true,
  direction: "incoming",
  channel_type: "D",
});
```

No sender filter means any sender. The session decides what to do for each verified sender.

Record known service send intents/receipts, sending account and available caller/correlation
context. Do not trust arbitrary post properties as proof of origin. By default, new subscriptions
exclude known service-origin **outgoing** echoes; opt in with
`include_service_outgoing: true`. Preserve legacy subscriptions' documented matching behavior.

Incoming messages remain eligible when another controlled account sent them through MCP.
Therefore an operator's MCP-origin message can still wake the assistant account. External-origin
self-authored messages may come from a browser, phone or another API client; do not label them
proven-human. Address the socket-echo-before-send-response race explicitly. This suppresses local
echoes; two autonomous sessions generating distinct replies can still loop, so session policy
must use sender/correlation context.

Keep the existing 48-hour body-retention default. Permanent registration does not imply an
unbounded delivery queue. Define bounded journal/pending-delivery retention and report expired
undelivered events. Retention cleanup must never delete configuration, credentials or active
registration identity. No subscription means no OpenCode wake-up.

## Implementation sequence

Each phase depends on the preceding contracts. Do not implement later phases against an
unreviewed assumption merely because their checkbox exists.

### P1 — schema, migrations and seed-once configuration

- [ ] Add ordered SQL files and a migration ledger with version/checksum/time, serialized startup
      migration, transactional application and rejection of unsupported future schemas.
- [ ] Replace inline schema evolution. Design account/scope-qualified keys from the start:
      settings/credentials, accounts/scopes, posts/directory/recovery, inbox receipts,
      events/send receipts, subscriptions/deliveries. Do not duplicate an existing responsibility.
- [ ] Import legacy environment/settings/login and known cache scopes through an explicit,
      idempotent migration path. Preserve post ordering/readCount,
      subscription IDs/filters/start/expiry/retries and uncertain delivery identities. If legacy
      scopes have colliding sequence numbers, atomically remap receipt references and cursors
      while preserving their selection/progress semantics.
- [ ] Make all entry points use DB configuration; retain current behavior with one account.
      Keep network validation outside long SQLite write transactions.

**Done:** fresh initialization, legacy import, seed removal/change after startup, failed migration,
repeated startup, revision conflict and failed configuration activation tests pass.
**Handoff:** actual tables/keys, migration version, bootstrap precedence, import mapping and binary
compatibility. Revise P2–P7 to use them. A code rollback does not automatically undo a schema upgrade.

### P2 — independent account lifecycle

- [ ] Load configured accounts from SQLite. One client/listener/recovery state per enabled account.
      A bad token or reconnecting account must not stop healthy accounts.
- [ ] Support list/add/disable, label updates and verified credential rotation through operator
      CLI/admin boundaries. Secrets enter through private inputs, not ordinary MCP arguments.
- [ ] Scope settings, guards, directory/cache invalidation and request draining correctly.
      Access-policy changes fence stale work and invalidate affected deliveries.
- [ ] Expose per-account identity, connection/recovery state, checkpoint, last success and safe
      error category. Distinguish authentication, upstream availability and storage failures.

**Done:** two independent accounts operate; failed activation/rotation leaves working accounts
intact; disabling one stops its workers without resetting the other.
**Handoff:** lifecycle and activation semantics; revise P3 routing, P4 ingestion and P5 retry rules.

### P3 — account-aware MCP and management contracts

- [ ] Add account discovery/status and explicit selection to domain tools, generic API, files,
      directory/cache, subscriptions and management where applicable.
- [ ] Select before all policy/resource checks. Preserve routing through retries, cancellation
      and indirect resource lookup; reject unknown/ambiguous/disabled selectors before I/O.
- [ ] Return account context in discovery, cache and event results while preserving documented
      response compatibility where possible. Keep tool schemas compact and strict.
- [ ] Update tool docs and the repository's agent skill with account selection and the exact
      subscribe-current-session workflow.

**Done:** concurrent calls cannot cross tokens, scopes, policies, cursors or receipts; one-account
compatibility is explicit and tested.
**Handoff:** final public schemas/errors and compatibility; revise P4/P5 envelopes and P6/P7 cases.

### P4 — durable event changes and send provenance

- [ ] Implement posted/edited/deleted event identities and atomic snapshot/journal writes.
      Retain minimal verified deletion metadata before clearing snapshots. Recheck current channel
      access; a deleted post is expected to return 404. Define fail-closed behavior when strict
      per-post visibility cannot be established, without retaining bodies or bypassing protection.
- [ ] Reconcile reconnects without duplicate posted notifications; expose partial recovery.
      Preserve edits/read counters and membership-race protection.
- [ ] Track convenience sends and supported post-creating generic API routes without blindly
      retrying writes. Treat unrecognized/indirectly generated posts as unknown/external origin.
      Resolve origin races and apply the outgoing-only echo rule.
- [ ] Keep journal, pending work and per-account processing bounded and fair.

**Done:** duplicate/reordered events, same DM under both accounts, edit/delete, expiry, recovery
and socket-before-response cases pass.
**Handoff:** event version/order, retention, origin fallback and tombstone rules; revise P5 cursors
and all later expected delivery counts.

### P5 — permanent subscriptions and reliable session delivery

- [ ] Store account/scope, event filters, destination/session, lifetime, cursor and delivery state.
      Add permanent mode, renew/list/cancel and explicit failure visibility.
- [ ] Preserve caller metadata attachment and approved destination validation. Include account
      identity in callback metadata and subsequent-tool instructions.
- [ ] Persist pending IDs before sending; acknowledge only a verified receipt. Classify network,
      auth, missing session, refusal and malformed receipt failures without leaking content.
- [ ] Define pause/terminal/retry behavior for disabled accounts, removed targets, deleted sessions,
      expired data and cancellation. One failed destination must not stall unrelated subscriptions.

**Done:** restart/lost-response retries preserve identity; wrong receipts do not advance cursors;
permanent registrations survive restart; expiry/unsubscribe stop new deliveries.
**Handoff:** actual API, receipt, state transitions and diagnostic fields; revise P6/P7 and docs.

### P6 — integrated regression gate

- [ ] Extend existing fixtures with distinct account tokens/users rather than duplicating the API
      catalog suite. Run the acceptance matrix below and the existing access/race/cancellation tests.
- [ ] Run locked install, lint, full offline suite, build and portability in an isolated checkout.
      Keep live integration opt-in; never rebuild the running checkout as a validation shortcut.
- [ ] Document precisely which guarantees are mock-tested, source-verified or still live-only.

**Done:** all material failures fixed, tested source identified, only explicit live checks remain.
**Handoff:** tested commit/schema and evidence; reopen earlier phases if fixes changed their contracts.

### P7 — deployment and controlled two-account acceptance

- [ ] Deploy the tested revision under a controlled service stop/migrate/start. Verify database
      version, runtime/build identity, both accounts and MCP client compatibility.
- [ ] Use two operator-designated test accounts, a dedicated DM and dedicated test sessions.
      Select an existing working model for tests; restrict test-session actions.
- [ ] Complete live acceptance below, including restart/backfill and temporary callback outage.
      Do not restart the shared OpenCode server just to test the Mattermost broker.
- [ ] Cancel test registrations, remove only test-created posts/sessions/artifacts, check final
      health/logs, update docs/version metadata as appropriate, commit and leave Git clean.

**Done:** both accounts work simultaneously in one service, the intended session actually resumes,
failure/restart cases recover, and the plan states any remaining limits.
**Handoff:** deployed commit/schema, final evidence, operational notes and any concrete follow-ups.

## Acceptance matrix

| Area              | Required proof                                                                                                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config/migration  | Seed exactly once; no seed/env override on later starts; settings and secrets survive restart; legacy counters/subscriptions retained; failed/future migration handled without partial activation.                                                                         |
| Isolation         | Same-server shared DM has independent directions/readCount; same IDs on different servers cannot collide; interleaved tools and receipts use the selected account; one failed account leaves the other usable.                                                             |
| Routing           | Incoming DM from either controlled profile resumes only its subscribed session. Sender-filter mismatch does not wake it. No subscription produces no wake-up.                                                                                                              |
| Outgoing          | External-client self-authored post is captured. Service-origin own outgoing echo is excluded by default, explicit inclusion works, and an MCP-origin message to the other controlled account still triggers that account's incoming subscription.                          |
| Event state       | Posted/edit/delete subscriptions behave as specified; default posted-only subscriptions do not wake on edits; ordering/duplicates/recovery preserve snapshots and counters; expired/denied content is not disclosed.                                                       |
| Delivery/lifetime | Caller metadata binding, permanent and timed lifetimes, renewal, unsubscribe, busy session, lost response, wrong receipt, unavailable target, listener restart and backfill; retries retain the same ID and produce one verified input/projection in the intended session. |
| End-to-end        | Verify persisted event, intended OpenCode receipt, and a later completed assistant acknowledgment independently. Provider/model errors remain distinguishable from broker failure.                                                                                         |
| Hygiene           | Non-consuming health checks; no real secrets/private bodies/host paths in tracked fixtures; lint/tests/build/portability pass; test-only cleanup verified; final Git state clean.                                                                                          |

## Mandatory phase handoff and replanning

Before beginning: read this plan, the latest handoff, relevant source and current Git/service
state. Complete one coherent phase at a time. Before checking it off, edit every affected future
phase in this same file; merely adding a note does not update an invalid requirement.

Keep one compact handoff per completed phase, replacing stale assumptions rather than growing
an unbounded activity log:

```text
Phase/status:
Public implementation commit(s):
Actual schema/config/API changes:
Synthetic verification and remaining acceptance checks (no private operational evidence):
New finding or changed decision:
Downstream edits: exact phases/criteria changed, or why none were needed
Next action: concrete file/module and expected result
```

A phase is incomplete without this handoff and its downstream edits. Reopen a completed phase
when later evidence invalidates its contract. Never mark a live check complete from mock success.

### Initial handoff

Status: design only; implementation begins with P0 verification and P1 storage contracts.
Known dependencies: import legacy JSON settings and scoped caches; make account selection
explicit; add event kinds, account-qualified callbacks and permanent subscription lifetimes.
Next: finalize the account/scope keys, migration ledger and import fixtures before changing
persistence. Do not build multi-account workers on the old single-account schema.
