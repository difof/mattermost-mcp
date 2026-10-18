---
"@bryanberger/mattermost-mcp": patch
---

Separate request construction, bounded response handling and audit generation into focused
modules. Reuse canonical base64 decoding, private JSON writes, version metadata and per-call
resource lookups.

Reject unsafe SDK route segments and unknown convenience-tool arguments. Return protocol errors
for unknown MCP tools, enforce returned post-channel restrictions and reject file redirects.

Preserve HTTP status and UTF-8 decoding across bounded error responses. Validate headers before
retries, recover rejected cached OAuth tokens during startup, bound token requests, validate
loopback callbacks and retain credentials when logout cleanup fails. Keep piped login answers
buffered without keeping the process alive after its final prompt.

Verify pinned audit source bytes even when Git index flags hide working-tree changes. Add focused
regressions and update the architecture and behavior documentation.
