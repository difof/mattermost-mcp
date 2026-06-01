# mattermost-mcp

MCP server (stdio) exposing the Mattermost REST API v4 as tools, for self-hosted instances.
User docs, tool catalog, and configuration reference live in `README.md`.

## Scope

Goals: let an agent read/write messages, navigate teams & channels, manage membership and read
state, look up users and presence, and upload/retrieve files — against a self-hosted instance, with
three interchangeable auth modes (`pat | password | oauth2`). Writes exist but are guardrail-gated
(safe by default).

Non-goals (v1): real-time WebSocket subscriptions, admin/system console, plugins,
webhooks/slash-command provisioning, compliance/data-retention, Boards/Playbooks/Calls.

## Commands

- `npm run dev` — run the server over stdio (tsx)
- `npm run build` — `tsc` → `dist/`
- `npm test` — vitest. Single file: `npx vitest run src/tools/messaging.test.ts`
- `npm run lint` — eslint + prettier

## Stack (fixed — do not swap)

- Node 20, ESM (`"type": "module"`), TypeScript NodeNext, `strict`
- `@modelcontextprotocol/sdk` ^1.29 — stdio transport
- `@mattermost/client` ^11.6 `Client4` for ALL HTTP — do not hand-roll fetch
- `zod` for every tool input schema
- `puppeteer-core` — CLI-only, **lazy-imported** in `src/mattermost/browser.ts` for `login --gitlab` (browser SSO). Never loaded on the server path. Uses the system Chrome (no bundled browser).

## Rules

- IMPORTANT: stdout is the MCP channel. Log ONLY to stderr. Never write to stdout.
- Validate every tool input with a zod schema before use.
- All writes go through `src/guardrails.ts`. Destructive tools (`delete_post`, `archive_channel`, `remove_member`) require arg `confirm: true` AND env `MM_ALLOW_DESTRUCTIVE=true`. `MM_READ_ONLY=true` disables all writes.
- Surface Mattermost API errors verbatim (status code + message). Do not swallow.
- IMPORTANT: never invent API paths. Use only `@mattermost/client` Client4 methods (verify in `node_modules`) or REST v4 endpoints documented at https://api.mattermost.com.
- `edit_post` uses `PUT /posts/{id}/patch` (not full replace). `send_dm` body is a JSON array of user ids (2 direct / 3–8 group).
- Auth modes: `pat | password | oauth2`. Password session token comes from the `Token` response header.
- `login --gitlab` (alias `--sso`): for non-admin users on IdP-only servers (GitLab/SAML) where PATs and OAuth2 apps are admin-gated. Drives the system browser, reads the `MMAUTHTOKEN` session cookie via CDP, and saves it as a `pat`. The token is a session token (expires); not a real PAT.

## Layout

- `src/index.ts` — CLI entry: dispatches `login`/`status`/`logout`/`--help` or starts the server
- `src/server.ts` — MCP server bootstrap (stdio)
- `src/commands/` — CLI subcommands (`login`, `status`, `logout`)
- `src/config.ts` — env parsing + validation (zod)
- `src/credentials.ts` — saved-login store (0600) + `resolveConfig` (env overrides saved creds)
- `src/paths.ts` — config-dir / credentials-file locations (XDG-aware)
- `src/prompt.ts` — dependency-free interactive stdin helpers (masked secret)
- `src/mattermost/` — `Client4` wrapper + auth strategies (incl. `browser.ts` — Chrome discovery + `MMAUTHTOKEN` capture for `login --gitlab`)
- `src/guardrails.ts` — read-only / destructive / allowlist checks
- `src/tools/` — tool defs per domain (messaging, channels, users, files) + `registry.ts`

## Conventions

- One tool file per domain; register through `src/tools/registry.ts`.
- All env vars are prefixed `MM_` (see `.env.example`).
