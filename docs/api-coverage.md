# Mattermost v11 API coverage

[Back to README](../README.md) · [Tool reference](tools.md) · [Testing](testing.md)

The server exposes **37 MCP tools**: 34 convenience tools and three on-demand API tools.
`api_call` covers **all 590 account-compatible core HTTP operations** in the pinned
**Mattermost v11.11.1** inventory. `api_search` and `api_describe` load operation details locally.

This is complete route/transport coverage for that account-credential scope. A PAT still needs
the appropriate account permissions, memberships, licenses and server features. Public login,
password-reset and similar endpoints can require their own request credentials or tokens.

## Scope and counts

The immutable source is [Mattermost v11.11.1, commit
`3acb3a7f684d11ccfcec4e5bd11c79f64e3eabf9`](https://github.com/mattermost/mattermost/tree/3acb3a7f684d11ccfcec4e5bd11c79f64e3eabf9),
using its [OpenAPI fragments](https://github.com/mattermost/mattermost/tree/3acb3a7f684d11ccfcec4e5bd11c79f64e3eabf9/api/v4/source)
and [core API registrations](https://github.com/mattermost/mattermost/tree/3acb3a7f684d11ccfcec4e5bd11c79f64e3eabf9/server/channels/api4).

| Inventory category                      |         Count | How this MCP handles it                                                                                 |
| --------------------------------------- | ------------: | ------------------------------------------------------------------------------------------------------- |
| Session-wrapper HTTP operations         |           564 | Callable with the configured account, subject to server authorization and endpoint requirements.        |
| Public-wrapper HTTP operations          |            26 | Callable; some require login/reset/invitation credentials in their request.                             |
| Remote-cluster-token HTTP operations    |             5 | Discoverable; refused before HTTP because the account credential cannot replace a remote-cluster token. |
| Cloud-key HTTP operations               |             1 | Discoverable; refused before HTTP because it requires a different credential.                           |
| Documented local-socket-only operations |             5 | Discoverable; refused because the configured transport is HTTP.                                         |
| **Complete comparison inventory**       |       **601** | Every record has an explicit transport/authentication classification.                                   |
| **Registered core HTTP operations**     |       **596** | 590 account-compatible plus six special-auth operations.                                                |
| **Account-compatible HTTP coverage**    | **590 / 590** | The generic executor dispatches every route in this scope.                                              |
| Convenience tool coverage               |            33 | The original 34 tools retain their focused interfaces.                                                  |

Of the 596 registered HTTP operations, 589 also appear in OpenAPI. Seven channel join-request
operations are registered in Go but absent from the pinned OpenAPI, so their contracts are
derived from the handlers and models. The documented REST count is 594: those 589 HTTP
operations plus five local-only operations. The [machine-readable audit](api-coverage.json)
retains this comparison and exact source references.

The five local-only operations are `DELETE /users`, `POST /config/migrate`,
`POST /integrity`, `POST /plugins/reattach` and `POST /plugins/{plugin_id}/detach`.
Paths in this paragraph are relative to `/api/v4`.

The count excludes WebSocket subscriptions, `/api/v5`, root-level routes, dynamically defined
plugin APIs such as separate Boards/Playbooks/Calls APIs, and catch-all 404 handlers. Core
plugin management, webhooks, slash-command provisioning, administration and other core v4
families are included. Newer/older v11 releases can have different operations or parameters;
this snapshot does not claim every v11 minor is identical.

## What is now available

The former ordinary-account gaps are reachable through the generic executor: cross-team
conversation discovery, group search, channel browsing and updates, team/member navigation,
thread inbox/follow/read operations, drafts, scheduled posts, preferences/sidebar settings,
bookmarks, broader post/file search, file previews/thumbnails, resumable uploads, emoji and
integration actions. Administration routes are reachable when the configured account has
the necessary permissions.

Use `api_search` to find an operation, `api_describe` to inspect its request and policy, then
`api_call` to invoke it. Canonical identifiers combine the HTTP method and parameterized path.
The upstream `SearchFiles` operation ID is duplicated, so ambiguous aliases require the
canonical identifier.

The [generated runtime catalog](../src/api/catalog.json) stores shared JSON schemas and
references to keep operation descriptions compact. Description includes only the components
referenced by the selected request; response schemas are opt-in. Runtime, tests and audit
utilities are native JavaScript. MCP API results use compact JSON.

## Request and response support

The executor handles JSON root objects, arrays and scalars; multipart text fields and multiple
file parts; raw binary upload bodies; primitive and repeated query parameters; conditional and
download headers; JSON with charset parameters; NDJSON; text; binary; empty responses; HEAD;
and 304 responses. It preserves status and selected headers. Redirects are returned without
following their target.

All responses, including errors, are bounded while streaming. Compressed transfer sizes do not
stand in for decoded sizes. HEAD/304 representation lengths do not count as downloaded bytes.
The default response limit is 1 MiB and can be raised explicitly per call.

The generic boundary validates the selected operation, complete path substitution, accepted
header names, body encoding and media type. It deliberately leaves business-object validation
to Mattermost: the official schema omits some real fields and request bodies. Unknown JSON
fields and query parameters remain available; request schemas are guidance, not a complete
client-side reproduction of Go's validators.

See the [request interface and examples](tools.md#request-and-response-interface).

## Corrections to upstream schemas

The generator records source-backed corrections rather than inventing requests to fill gaps:

- Both file-search operations consume JSON despite their OpenAPI multipart label.
- `POST /files` supports raw binary as well as multipart; raw mode needs `channel_id` and
  `filename` query values. Multipart text fields are emitted before file parts.
- Three omitted path-parameter declarations are restored; missing JSON-body declarations are
  supplemented from the pinned handlers.
- Elasticsearch index purging accepts repeated `index` query values.
- The deprecated GET access-policy activation operation requires `active=true|false`.
- The malformed custom-profile response schema and missing/incorrect binary success media are
  corrected from server code.
- Seven join-request operations include source-derived request/status/response models, including
  direct approval behavior and an empty 404 when no current request exists.

The exact changes and evidence are in the catalog's `corrections` and operation `source` records.
Every schema reference must resolve during generation.

## Guardrails and authorization

The official [PAT reference](https://docs.mattermost.com/developers/integrate/reference/personal-access-token)
describes PATs as account credentials. The catalog's authentication family identifies the
transport credential, not the permissions granted to a particular account. MFA/trusted-request
wrappers, body credentials, role checks, membership, license and feature/configuration gates
remain authoritative server behavior. Lexical permission/configuration hints in the inventory
are source pointers; missing hints do not imply unrestricted access.

The executor shares Client4's configured authentication and the session's timeout/recovery
mechanism. Callers cannot replace authentication headers, select arbitrary URLs, change HTTP
methods or supply their own safety classification.

Read-only and destructive checks use trusted operation policy. Audited POST searches/lookups
can be reads; several GET operations have side effects and are classified as writes. In
particular, policy activation changes access controls, revealing a post records its reveal and
starts expiration, and system ping can send test push notifications or run write health checks.
Generic DELETE and security/admin mutations require `MM_ALLOW_DESTRUCTIVE=true` plus
`confirm: true`. Mutations are not retried after ambiguous failures; an explicit 401 rejection
can trigger the existing one-time account-authentication recovery.

Generic execution is refused when a team/channel allowlist is set. An unrestricted administrative
API or arbitrary response shape cannot safely inherit the convenience tools' filtering.
The scoped convenience tools continue to enforce those restrictions. Message-writing API
operations also enforce the configured Unicode message-length limit.

## Verification and its limits

The [HTTP mock suite](../src/integration/mocked/) compares the runtime catalog against the
independently generated 601-entry route inventory. Every record is accounted for: 590 successful
dispatches and 11 explicit unsupported-credential/transport refusals. Expected HTTP methods and
paths are rendered independently of the production URL builder, and the actual MCP registry,
Client4 options and session runner are exercised.

The generated sweep proves registration, dispatch and representative serialization. Its
synthetic responses do not prove that a live server accepts every generated business object.
Separate source-checked workflow tests cover uploads/downloads, query edge cases, join requests,
drafts, resumable uploads, scalar/empty responses, redirects, errors, retry decisions and guards.
The existing convenience-tool workflows and focused credential/resource/streaming regressions
remain in place.

Live deployment validation is still required for permissions, retention, search indexes,
licenses, enabled features, large real datasets and version-specific server behavior. Optional
live smoke tests remain explicitly opt-in; no real Mattermost account is used by the mock suite.

## Reproduce the inventory and catalog

These native Node.js utilities use the development-only npm `yaml` parser. Run `npm ci` to
install the development dependencies. The audit tools and parser are not required to run
the packaged MCP server.

```bash
node scripts/audit-api-coverage.mjs --download
node scripts/generate-api-catalog.mjs --download
npx prettier --write docs/api-coverage.json src/api/catalog.json
```

Use `--check` on either script to verify instead of rewriting. `--cached-source /path/to/cache`
supports offline verification against the pinned source manifest; `--source /path/to/mattermost`
requires a clean checkout at the exact pinned commit. The base 149 source files and seven
supplemental model/app/web files are hash-verified. Inventory validation also tracks the MCP
tool sources, so regenerate the audit before the catalog after tool-source changes.

The production build copies native JavaScript and the catalog into a clean `dist/`.
No compiler, audit scripts, source fixtures or tests are required in the published runtime.
