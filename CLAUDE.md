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

- `npm run dev` — run the server over stdio (tsx)
- `npm run build` — clean `dist/`, compile JS/TS, and copy the generated API catalog
- `npm test` — vitest. Single file: `npx vitest run src/tools/messaging.test.ts`
- `npm run test:mocks` — real MCP/Client4 requests against a local mock API (no credentials)
- `npm run test:integration` — optional real-server smoke tests (see `docs/testing.md`)
- `npm run lint` — eslint + prettier

## Stack (fixed — do not swap)

- Node 20, ESM (`"type": "module"`). Prefer JavaScript for new runtime code; keep existing
  TypeScript strict and use minimal type glue at shared boundaries. Do not generate endpoint interfaces.
- `@modelcontextprotocol/sdk` ^1.29 — stdio transport
- `@mattermost/client` ^11.6 `Client4` for authentication/options. Bounded raw API/file transport
  shares `runClientRequest` for timeouts, credential recovery and trusted retry policy.
- `zod` for every tool input schema
- `puppeteer-core` — CLI-only, **lazy-imported** in `src/mattermost/browser.ts` for `login --gitlab` (browser SSO). Never loaded on the server path. Uses the system Chrome (no bundled browser).

## Rules

- IMPORTANT: stdout is the MCP channel. Log ONLY to stderr. Never write to stdout.
- Validate every tool input with a zod schema before use.
- All writes go through `src/guardrails.ts`. Destructive operations require arg `confirm: true`
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

- `src/index.ts` — CLI entry: dispatches `login`/`status`/`logout`/`--help` or starts the server
- `src/server.ts` — MCP server bootstrap (stdio)
- `src/commands/` — CLI subcommands (`login`, `status`, `logout`)
- `src/config.ts` — env parsing + validation (zod)
- `src/credentials.ts` — saved-login store (0600) + `resolveConfig` (env overrides saved creds)
- `src/paths.ts` — config-dir / credentials-file locations (XDG-aware)
- `src/prompt.ts` — dependency-free interactive stdin helpers: masked secret + `select()` arrow-key menu (raw-mode TTY, non-TTY numbered fallback)
- `src/mattermost/` — `Client4` wrapper + auth strategies (incl. `browser.ts` — Chrome discovery + `MMAUTHTOKEN` capture for `login --gitlab`; `default-browser.ts` — OS default-browser detection, Chromium-only)
- `src/guardrails.ts` — read-only / destructive / allowlist checks
- `src/api/` — JavaScript discovery, policy and bounded transport; generated `catalog.json`
- `scripts/generate-api-catalog.py` — audit-only catalog generation from pinned official sources
- `src/tools/` — tool defs per domain (messaging, channels, users, files) + `registry.ts`

## Conventions

- One tool file per domain; register through `src/tools/registry.ts`.
- All env vars are prefixed `MM_` (see `.env.example`).
