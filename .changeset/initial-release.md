---
"mattermost-mcp": minor
---

Initial public release. MCP (stdio) server exposing the Mattermost REST API v4 as 34 tools across messaging, channels/teams, users/presence, and files. Three auth modes (PAT, password, OAuth2 PKCE), guardrails (read-only + destructive-confirm), and transport resilience (retry with backoff + per-request timeout).
