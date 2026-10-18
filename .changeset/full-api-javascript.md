---
"@bryanberger/mattermost-mcp": minor
---

Expose all 590 account-compatible core HTTP operations in the pinned Mattermost v11.11.1
inventory through `api_search`, `api_describe` and `api_call`. Keep the 34 convenience tools,
return shared request schemas on demand and make response schemas opt-in to reduce agent context.

Implement the new runtime and API tests in JavaScript, with minimal existing TypeScript changes
and no generated endpoint interfaces. Support JSON, multipart and raw uploads, bounded binary
and text downloads, conditional requests and operation-specific write/retry policy.

Add exhaustive MCP-to-HTTP route dispatch, source-checked contract and authentication/policy
mocks. Make catalog generation reproducible from pinned official sources, clean production
builds before copying the catalog, and update the concise README and detailed reference docs.
