---
"@bryanberger/mattermost-mcp": patch
---

Convert the remaining runtime and tests to native JavaScript ESM, preserving the existing MCP
tools, authentication and guardrails. Remove type-only modules and tool-definition wrappers,
the TypeScript/tsx build setup and the temporary mixed-source test resolver.

Port both API audit and catalog generators from Python to JavaScript with the same pinned
source verification and catalog output. Package the runtime with a clean file-copy build,
use standard JavaScript linting, and update the development instructions and source links.
