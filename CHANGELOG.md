# @bryanberger/mattermost-mcp

## 0.3.0

### Minor Changes

- [#4](https://github.com/BryanBerger98/mattermost-mcp/pull/4) [`da9d01f`](https://github.com/BryanBerger98/mattermost-mcp/commit/da9d01fdfc9dcdacb21a29f8fa67a42ed5c9c91d) Thanks [@BryanBerger98](https://github.com/BryanBerger98)! - Add a management CLI to the `mattermost-mcp` binary. After `npm i -g @bryanberger/mattermost-mcp`, run `mattermost-mcp login` for an interactive auth wizard (PAT, password, or OAuth2) that validates and saves credentials (0600) under the config dir; the MCP server then uses them automatically — no env vars required. Also adds `status` (print the authenticated identity) and `logout` (clear saved credentials). `MM_*` environment variables still take precedence over saved credentials. Password logins are exchanged for a session token at login time, so no password is ever written to disk.

## 0.2.1

### Patch Changes

- [`fd203df`](https://github.com/BryanBerger98/mattermost-mcp/commit/fd203df4f1289ab04e5fe0874657fe3fc17fbd04) Thanks [@BryanBerger98](https://github.com/BryanBerger98)! - Releases are now published via npm trusted publishing (OIDC) with automatic provenance. No functional changes to the server or tools.

## 0.2.0

### Minor Changes

- [#1](https://github.com/BryanBerger98/mattermost-mcp/pull/1) [`4d5b2ed`](https://github.com/BryanBerger98/mattermost-mcp/commit/4d5b2edf637e7d795aceee9c939f9ebb82ae20a4) Thanks [@BryanBerger98](https://github.com/BryanBerger98)! - Initial public release. MCP (stdio) server exposing the Mattermost REST API v4 as 34 tools across messaging, channels/teams, users/presence, and files. Three auth modes (PAT, password, OAuth2 PKCE), guardrails (read-only + destructive-confirm), and transport resilience (retry with backoff + per-request timeout).
