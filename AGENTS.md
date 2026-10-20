# Repository guide

This fork exposes Mattermost REST API v4 over MCP stdio using the configured account's permissions.
Start with [README.md](README.md). Read the relevant [tool contracts](docs/tools.md),
[configuration](docs/configuration.md), [testing guide](docs/testing.md) or
[API coverage boundaries](docs/api-coverage.md) before changing that area.
For operating Mattermost from an agent, use [the skill](.agents/skills/mattermost-mcp/SKILL.md);
keep conversation workflows and host-specific Code Mode recipes there.

## Code organization

| Location                                                                     | Responsibility                                                                                                                    |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.js`, `src/commands/`, `src/server.js`                             | Lazy CLI dispatch, login/status/logout, MCP bootstrap                                                                             |
| `src/tools/`                                                                 | Domain tool definitions; `index.js` aggregates domain arrays; `registry.js` validates, guards, dispatches and formats MCP results |
| `src/mattermost/`                                                            | Client4 sessions, authentication, request resilience, bounded HTTP/file transport and CLI browser SSO                             |
| `src/config.js`, `src/credentials.js`, `src/private-json.js`, `src/paths.js` | Configuration, saved-login resolution, atomic private persistence and storage paths                                               |
| `src/guardrails.js`, `src/resource-guardrails.js`                            | Pure policy checks, indirect resource resolution, per-call caches and result filtering                                            |
| `src/api/`                                                                   | Operation discovery/policy, request serialization, execution and generated `catalog.json`                                         |
| `scripts/`                                                                   | Copy-only build, pinned source verification, coverage audit and catalog generation                                                |

## Implementation rules

- Use native JavaScript ESM with explicit `.js`/`.mjs` imports, plain objects and small functions.
  Node 20+ is supported. Keep dependency versions in `package.json`/`package-lock.json` and the
  runtime version in `src/version.js`, which reads package metadata. Do not add TypeScript or
  declaration files; avoid elaborate JSDoc type systems. Prefer JavaScript for maintenance utilities.
- Keep behavior in its owning domain. Share helpers for actual repeated behavior; avoid generic
  frameworks, catch-all utility modules and parallel implementations of existing transport/policy.
- Add tools to their domain arrays and expose them through `src/tools/index.js`. Use strict Zod
  object schemas at tool boundaries and `src/tools/route-params.js` for literal SDK route values.
  Keep writes, destructive flags and resource checks attached to the tool definition.
- Preserve MCP stdout for protocol traffic; send diagnostics to stderr. CLI result output is
  separate. Keep command modules lazy and `puppeteer-core` confined to CLI browser login;
  help/version must work without authentication or loading browser dependencies.
- Keep result formatting in `registry.js`: unknown tool names raise MCP `InvalidParams`;
  validation, guardrail and API failures return `isError: true`. Preserve useful HTTP status and
  error details. Convenience results are resources; `api_call` adds its HTTP response envelope.
  Host-side MCP decoding belongs in usage guidance, not server-specific response workarounds.
- Classify generic operations using trusted catalog policy, not HTTP verbs or caller-supplied
  safety flags. `MM_READ_ONLY=true` blocks writes; destructive calls require both
  `MM_ALLOW_DESTRUCTIVE=true` and `confirm: true`. Preserve message limits, indirect resource checks
  and filtered results. Generic `api_call` is disabled when team/channel allowlists are set.
- Keep retries and authentication recovery at the individual request boundary. Never replay a
  tool callback or blindly retry an ambiguous write. Preserve credential-origin isolation,
  deadlines and decoded response-size limits. Never follow API/file redirects: generic calls
  return 3xx responses, while file/metadata requests reject them.
- Keep credentials private and atomically persisted. An overridden `MM_URL` must not send saved
  credentials to a different server. Never persist plaintext login passwords or put real tokens
  in source, tests or logs. Use `MM_` for Mattermost-specific settings; XDG and browser-discovery
  environment variables also exist. Browser SSO saves an expiring session token, not a true PAT.
- Preserve the distinction between MCP arguments and HTTP payloads: `send_dm` accepts
  `{user_ids, message}` with one to seven unique **other** participants; its handler inserts the
  authenticated user into the direct/group channel request. `edit_post` uses the patch endpoint.

## Generated API data

Do not hand-edit `src/api/catalog.json` or `docs/api-coverage.json`, or patch generated `dist/`.
Use the pinned official sources and reproducible corrections in `scripts/api-catalog-corrections.mjs`.
Run the coverage audit before catalog generation; tool-source changes can also require refreshing
the inventory. Follow [the regeneration procedure](docs/api-coverage.md#reproduce-the-inventory-and-catalog),
including verified cached sources and `--check` when available. Keep schemas on demand rather than
expanding every endpoint into startup tool descriptions.

Coverage means the pinned core account-compatible HTTP surface, not every account's permissions,
license or deployment behavior. Special-auth/local routes are catalogued but not account-callable;
WebSocket events and dynamically defined plugin APIs are outside this executor's scope.

## Verification and delivery

- Install locked dependencies with `npm ci`. Use `npm run lint` for ESLint/Prettier,
  `npx --no-install vitest run <test-file>` for focused tests, `npm run test:mocks` for MCP-to-HTTP
  contracts, and `npm test` for the full suite. CI runs install, lint, tests and build on Node 24.
- Run checks proportional to the change. Documentation edits need formatting and reference checks;
  behavior changes need focused regressions. Reuse the loopback HTTP fixture for request/response
  contracts, and keep unit tests for independent failures. Avoid redundant SDK-forwarding tests or
  emulating Mattermost's business logic in mocks. Mock success does not prove live authorization.
- `npm run build` cleans `dist/` and copies runtime JavaScript/catalog, excluding tests and fixtures;
  it does not compile code or regenerate the catalog. `npm run dev` and `npm start` launch the
  authenticated server from source and `dist/`, respectively; they are not offline validation.
- Keep `MM_INTEGRATION` unset for offline tests. Run `npm run test:integration` only for an explicitly
  authorized live check. With `MM_TEST_CHANNEL_ID`, it posts, reads and deletes through Client4,
  outside the MCP tool guardrails. See [live-test requirements](docs/testing.md#optional-live-checks).
- Keep changes scoped and report what was verified. When committing, use Conventional Commits and
  one commit per changed file; finish each file before committing it. The default branch is `master`.
  This fork installs from source; the release workflow is restricted to upstream. `npm run release`
  publishes packages and is not a validation command.
