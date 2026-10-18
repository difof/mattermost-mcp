# Testing

[Back to README](../README.md) · [API coverage](api-coverage.md)

## Commands

| Command                    | Runs                                | Real Mattermost account needed? |
| -------------------------- | ----------------------------------- | ------------------------------- |
| `npm test`                 | Unit tests and mocked API workflows | No                              |
| `npm run test:mocks`       | Only the MCP-to-HTTP mock suite     | No                              |
| `npm run test:integration` | Optional live-server smoke tests    | Yes                             |
| `npm run build`            | Clean JavaScript runtime package    | No                              |
| `npm run lint`             | ESLint and Prettier                 | No                              |

Live tests are skipped during `npm test` unless `MM_INTEGRATION=1` is explicitly set. Production
builds clean `dist/` and copy the JavaScript runtime and generated API catalog. Tests and the
integration fixture are excluded. Source and production use the same native `.js` imports;
there is no compiler or custom test resolver.

## What the API mocks test

The mock suite exercises all **37 exposed tools**: personal-account workflows through the
34 convenience tools, plus catalog, transport and policy coverage through the three API tools
for the complete pinned account-compatible HTTP inventory.

The mock suite uses a real MCP client/server pair, the production tool registry, `createSession`,
and the installed Mattermost `Client4`. Only Mattermost itself is replaced by a loopback HTTP
server with synthetic users, channels, posts and a fake PAT.

The shared HTTP fixture checks request methods, paths, queries, headers, bodies and fake-PAT
Bearer authentication. Unexpected requests and unconsumed expectations fail the test. Calls
outside the local mock URL are blocked, and the fixture checks manual redirect handling. Test
cases assert the decoded MCP result as well as the request contract. Nothing connects to a
configured production server.

| Suite                                                                                  | Workflows                                                                                                                                                                  |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Personal messaging](../src/integration/mocked/personal-messaging.test.js)             | Identity and presence; user lookup; existing DMs/groups; posting, replies, history, threads, search, edits, pins and reactions                                             |
| [Channels and membership](../src/integration/mocked/channels-and-membership.test.js)   | Teams/channels; ordinary channel lifecycle and membership; pagination; actual unread counts; read state                                                                    |
| [Files and errors](../src/integration/mocked/files-and-errors.test.js)                 | Multipart uploads and attachments; metadata and binary downloads; API errors; safe-read retries; mutation failures; guardrails                                             |
| [API catalog and dispatch](../src/integration/mocked/api-catalog-dispatch.test.js)     | All 601 inventory entries; 590 successful route dispatches; 11 special-auth/local refusals; on-demand schema closure; search and aliases                                   |
| [API contracts](../src/integration/mocked/api-contracts.test.js)                       | JSON arrays/scalars/null, repeated queries, multipart/raw/resumable uploads, binary/text/HEAD/304, redirects, bounded streams and seven source-checked join-request routes |
| [API authentication and policy](../src/integration/mocked/api-auth-and-policy.test.js) | HTTP-status/error preservation; account/header/path boundaries; read-only/destructive checks; allowlists; message limits; read retries and write replay prevention         |

### Exhaustive dispatch versus endpoint semantics

The dispatch suite compares the runtime catalog against the independently generated
[`docs/api-coverage.json`](api-coverage.json), including authentication and transport
classification. It groups the **590 account-compatible operations** by their six HTTP methods
and sends each through the real registry and transport. Expected method/path values come from
the audit's canonical route keys, independently of the production URL builder. The remaining
six special-auth HTTP and five local-socket operations must fail before a request is sent.

Structural request samples follow the available schemas, and synthetic responses identify the
selected operation. This proves dispatch and representative serialization, not that Mattermost
accepts every generated business object. Curated contract tests separately check real request
shapes against pinned server handlers, including corrections to incomplete OpenAPI definitions.
Description tests verify the transitive schema references for every inventory record, with
response schemas returned only when requested.

These are contract and workflow tests. Their responses are controlled fixtures, so they do not
prove how a live Mattermost deployment enforces permissions, search indexing, retention, feature
flags or licenses. A simulated `403` verifies error propagation, not Mattermost's authorization
implementation. See [API coverage](api-coverage.md) for the pinned official version, source
corrections and the exact boundaries of full account-API coverage.

Convenience-tool error fixtures use Mattermost's normal `AppError` JSON, including `status_code`,
as consumed by Client4. The generic transport additionally tests empty and proxy-text errors,
charset-bearing JSON and a mismatched body status: the actual HTTP status remains authoritative.
Oversized error responses stop at the configured limit and are not retried.

File and metadata requests also reject redirects, bound error bodies and recover from rejected
OAuth tokens without losing the HTTP status when an error stream breaks. Transport regressions
cover UTF-8 BOM decoding and malformed headers rejected before any retry or network request.

## Test cleanup policy

Keep tests that catch an independent failure. Replace simple “tool calls SDK method” assertions
when a real MCP-to-HTTP test covers that method's route, payload and returned value. Use tables
for related input cases instead of repeated setup.

Focused unit tests remain useful for failures that are hard to reproduce reliably over a socket:
stream cancellation, exact byte limits, concurrent authentication recovery, credential isolation,
file permissions, schema conflicts and indirect resource restrictions. Exercising those policies
once at the HTTP/MCP boundary complements the detailed unit cases.

CLI subprocess tests cover dependency-free help/version output, buffered piped answers, EOF
cancellation and exit with an open input pipe. Authentication tests cover atomic private-file
replacement, failed logout cleanup, loopback OAuth callbacks, bounded token requests and cached
tokens rejected during startup. Audit tests use disposable Git checkouts to verify the pinned
revision and actual source hashes, including changes hidden by Git index flags.

Keep exhaustive route dispatch table-driven rather than adding hundreds of near-identical test
functions. Add a source-checked contract case when an endpoint has distinct serialization or
response behavior, and add a focused regression when a bug reveals a separate failure mode.
Do not duplicate Mattermost's business logic in the mock server.

## Optional live checks

Use a Mattermost v11 test instance and a PAT for an account you control. The repository's
`docker-compose.yml` starts a disposable preview server, but its floating `latest` image is not a
version-pinned v11 compatibility check.

Set `MM_URL` and `MM_TOKEN` in your local environment, then run:

```bash
MM_AUTH_MODE=pat npm run test:integration
```

With `MM_TEST_CHANNEL_ID` unset, the live suite reads the current identity and team list only.
To enable its post → read → delete round trip, set that variable to a dedicated test channel:

```bash
MM_AUTH_MODE=pat MM_TEST_CHANNEL_ID=your-test-channel-id npm run test:integration
```

That optional case uses `Client4` directly and performs real writes; the tool-layer
`MM_READ_ONLY` and destructive-action flags do not apply to it. The three live smoke tests are
not an exhaustive acceptance suite. Existing DM/group visibility, large histories, membership
permissions, file access and your exact v11 configuration still need deployment-specific checks.
