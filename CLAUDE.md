# mattermost-mcp

MCP server (stdio) exposing the Mattermost REST API v4 as tools, for self-hosted instances.
Start with `README.md`; full tool, configuration, testing and API coverage references live in `docs/`.

## Scope

Expose the pinned Mattermost core REST API through 34 convenience tools and three on-demand
API tools. Account-compatible admin, webhook, command and other core endpoints are in scope;
Mattermost enforces the account's permissions. PAT, password and OAuth2 authentication are
supported, with endpoint-specific credential restrictions. Local sockets, special remote-cluster/cloud credentials, WebSocket events,
v5 and dynamically defined plugin APIs are outside the generic executor's account/HTTP scope.

## Commands

- `npm run dev` — run the JavaScript source directly on Node over stdio
- `npm run build` — clean `dist/` and copy the runtime JavaScript and generated API catalog
- `npm test` — vitest. Single file: `npx vitest run src/tools/messaging.test.js`
- `npm run test:mocks` — real MCP/Client4 requests against a local mock API (no credentials)
- `npm run test:integration` — optional real-server smoke tests (see `docs/testing.md`)
- `npm run lint` — eslint + prettier

## Stack (fixed — do not swap)

- Node 20+, native JavaScript ESM (`"type": "module"`). Runtime, tests and development scripts
  are JavaScript. Keep tool definitions as plain objects and validate external inputs with Zod;
  do not add TypeScript, declaration files or large JSDoc type structures.
- `@modelcontextprotocol/sdk` ^1.29 — stdio transport
- `@mattermost/client` ^11.6 `Client4` for authentication/options. Bounded raw API/file transport
  shares `runClientRequest` for timeouts, credential recovery and trusted retry policy.
- `zod` for every tool input schema
- `puppeteer-core` — CLI-only, **lazy-imported** in `src/mattermost/browser.js` for `login --gitlab` (browser SSO). Never loaded on the server path. Uses the system Chrome (no bundled browser).

## Rules

- On the MCP server path, stdout is the protocol channel; log only to stderr. CLI commands
  may write their results to stdout.
- Validate tool arguments with strict Zod object schemas before use. Convenience tools use
  `src/tools/route-params.js` for identifiers and names interpolated into SDK routes.
- Tool writes go through `src/guardrails.js`. Destructive operations require arg `confirm: true`
  AND env `MM_ALLOW_DESTRUCTIVE=true`. `MM_READ_ONLY=true` disables all writes. API policy is
  operation-specific; never infer safety solely from the HTTP verb or caller input.
- Surface Mattermost API errors verbatim (status code + message). Do not swallow.
- Never invent API paths. Convenience tools use verified Client4 methods; generic operations
  come from the pinned catalog, generated from official OpenAPI and core route registrations.
  Keep source-based schema corrections reproducible in the generator.
- Generic API execution must not bypass team/channel allowlists, change authentication, follow
  redirects, or replay ambiguous writes. Return schemas only on demand and use compact JSON for API results.
- `edit_post` uses `PUT /posts/{id}/patch` (not full replace). `send_dm` body is a JSON array of user ids (2 direct / 3–8 group).
- Auth modes: `pat | password | oauth2`. Password session token comes from the `Token` response header.
- `login --gitlab` (alias `--sso`, also a `gitlab / SSO` choice in the interactive menu): for non-admin users on IdP-only servers (GitLab/SAML) where PATs and OAuth2 apps are admin-gated. Drives the user's default Chromium browser (else first installed), reads the `MMAUTHTOKEN` session cookie via CDP, and saves it as a `pat`. The token is a session token (expires); not a real PAT.

## Layout

- `src/index.js` — CLI entry: loads only the requested command or server; help/version need no auth
- `src/version.js` — package version shared by CLI output, MCP initialization and User-Agent headers
- `src/server.js` — MCP server bootstrap (stdio)
- `src/commands/` — CLI subcommands (`login`, `status`, `logout`)
- `src/config.js` — shared defaults, env parsing and server/OAuth redirect URL validation
- `src/credentials.js` — saved-login store (0600) + `resolveConfig` (env overrides saved creds)
- `src/private-json.js` — atomic, private JSON writes for credentials and OAuth tokens
- `src/paths.js` — config-dir / credentials-file locations (XDG-aware)
- `src/prompt.js` — masked secrets, selection menus and buffered answers from piped stdin
- `src/mattermost/` — `Client4` wrapper + auth strategies (incl. `browser.js` — Chrome discovery + `MMAUTHTOKEN` capture for `login --gitlab`; `default-browser.js` — OS default-browser detection, Chromium-only)
- `src/mattermost/resilience.js` — per-request timeouts, safe retries and authentication recovery
- `src/mattermost/http-response.js` — decoded response limits and HTTP error handling shared by
  API/file transport; OAuth also uses its bounded reader
- `src/mattermost/files.js` / `binary.js` — file metadata/downloads and shared base64 decoding
- `src/guardrails.js` — pure write, destructive, allowlist and message-length checks
- `src/resource-guardrails.js` — resource resolution, per-call read caches and result filtering
- `src/api/` — discovery and operation policy; `request.js` serializes requests, `client.js`
  executes them and decodes results; `catalog.json` is generated data
- `scripts/audit-api-coverage.mjs` / `generate-api-catalog.mjs` — development-only inventory and
  catalog generation from pinned official sources; use the npm `yaml` parser
- `src/tools/` — plain tool definitions per domain; `registry.js` owns MCP schemas, dispatch,
  validation and error mapping; `route-params.js` validates literal convenience-tool route values

## Conventions

- One tool file per domain; register through `src/tools/registry.js`.
- All env vars are prefixed `MM_` (see `.env.example`).
