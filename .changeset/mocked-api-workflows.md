---
"@bryanberger/mattermost-mcp": patch
---

Exercise the exposed tools through real MCP, Client4 and a strict local Mattermost HTTP mock.
Replace redundant SDK-forwarding tests while keeping independent guardrail, authentication,
credential and streaming regressions. Fix full-thread retrieval silently defaulting to a
60-post SDK page, and reject empty team IDs that accidentally trigger cross-team searches.
Support the required expiration timestamp for timed custom statuses and validate duration values.
Separate mocked and live test commands, keep fixtures out of production
builds, and document the pinned v11 API coverage and remaining gaps with a shorter README.
