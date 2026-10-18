---
"@bryanberger/mattermost-mcp": patch
---

Prevent duplicate mutations after transient HTTP failures while retaining safe-read retries and
per-request authentication recovery. Enforce resource allowlists for indirect post/file references,
attachments, and collection results. Validate history filters and DM participants, return actual
unread counts, bound streaming downloads, and keep saved credentials private and tied to their
server URL. Use `master` for the fork's CI and changeset base, with source installation instructions.
