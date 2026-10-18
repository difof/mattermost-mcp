# Testing

[Back to README](../README.md) · [API coverage](api-coverage.md)

## Commands

| Command                    | Runs                                | Real Mattermost account needed? |
| -------------------------- | ----------------------------------- | ------------------------------- |
| `npm test`                 | Unit tests and mocked API workflows | No                              |
| `npm run test:mocks`       | Only the MCP-to-HTTP mock suite     | No                              |
| `npm run test:integration` | Optional live-server smoke tests    | Yes                             |
| `npm run build`            | Production TypeScript build         | No                              |
| `npm run lint`             | ESLint and Prettier                 | No                              |

Live tests are skipped during `npm test` unless `MM_INTEGRATION=1` is explicitly set. Production
builds exclude the integration test directory, so the HTTP fixture is not shipped in `dist/`.

## What the API mocks test

The 32 mocked tests make successful calls to all 34 exposed tools, including tools that share a
REST endpoint. An explicit catalog assertion detects additions or removals that need review.

The mock suite uses a real MCP client/server pair, the production tool registry, `createSession`,
and the installed Mattermost `Client4`. Only Mattermost itself is replaced by a loopback HTTP
server with synthetic users, channels, posts and a fake PAT.

The HTTP fixture checks the request method, path, query, body and Bearer authentication.
Unexpected requests and unconsumed expectations fail the test. Test cases assert the decoded
MCP result as well as the request contract. Nothing connects to a configured production server.

| Suite                                                                                | Workflows                                                                                                                      |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| [Personal messaging](../src/integration/mocked/personal-messaging.test.ts)           | Identity and presence; user lookup; existing DMs/groups; posting, replies, history, threads, search, edits, pins and reactions |
| [Channels and membership](../src/integration/mocked/channels-and-membership.test.ts) | Teams/channels; ordinary channel lifecycle and membership; pagination; actual unread counts; read state                        |
| [Files and errors](../src/integration/mocked/files-and-errors.test.ts)               | Multipart uploads and attachments; metadata and binary downloads; API errors; safe-read retries; mutation failures; guardrails |

These are contract and workflow tests. Their responses are controlled fixtures, so they do not
prove how a live Mattermost deployment enforces permissions, search indexing, retention, feature
flags or licenses. A simulated `403` verifies error propagation, not Mattermost's authorization
implementation. See [API coverage](api-coverage.md) for the pinned official API version, the routes
these tools expose and the missing endpoints.

Error fixtures use Mattermost's normal `AppError` JSON, including `status_code`. The installed
Client4 reads the error code from that body; arbitrary proxy error pages or altered response
content types are outside this suite's compatibility claim.

## Test cleanup policy

This revision replaces 30 redundant cases, including the former stub-only MCP integration file,
with the 32 HTTP workflow tests. The reduced unit suites retain the independent regressions below.

Keep tests that catch an independent failure. Replace simple “tool calls SDK method” assertions
when a real MCP-to-HTTP test covers that method's route, payload and returned value. Use tables
for related input cases instead of repeated setup.

Focused unit tests remain useful for failures that are hard to reproduce reliably over a socket:
stream cancellation, exact byte limits, concurrent authentication recovery, credential isolation,
file permissions, schema conflicts and indirect resource restrictions. Exercising those policies
once at the HTTP/MCP boundary complements the detailed unit cases.

Mocking every unexposed Mattermost endpoint would test the mock itself. Add endpoint fixtures
when an MCP tool actually uses that endpoint; keep the inventory of missing APIs in the audit.

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
