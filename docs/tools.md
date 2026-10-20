# Tool reference

[Back to README](../README.md) · [API coverage](api-coverage.md)

Legend: ⚠️ = write (blocked by `MM_READ_ONLY=true`) · 💥 = destructive (requires
`MM_ALLOW_DESTRUCTIVE=true` **and** `confirm: true` per call)

## Arguments and errors

Use argument names exactly as advertised by `tools/list`. Extra argument names are rejected;
for example, `post_message` accepts `root_id`, and rejects a misspelled `rootId` before posting.

Convenience tools accept raw IDs, usernames and reaction names. Supply each as a literal value
without URL encoding, path separators, query/fragment syntax, whitespace or control characters.
Dot-only values are also rejected. These checks apply to IDs inside `user_ids` and `file_ids`;
Mattermost still validates the actual identifiers and names.

An unknown tool name raises the JSON-RPC `InvalidParams` error (`-32602`). Invalid arguments,
guardrail refusals and Mattermost API failures return a tool result with `isError: true` and a
message describing the failure.

## Full API (3)

These three tools expose the pinned core API without adding hundreds of schemas to every MCP
`tools/list` response. They complement the 34 convenience tools below.

| Tool           | Purpose                                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api_search`   | Local keyword search over operation IDs, summaries and tags; `limit` defaults to 10 (maximum 50), with `offset` pagination.                                               |
| `api_describe` | Request parameters/schema, authentication and write policy for one operation. Only referenced components are included; response schemas require `include_response: true`. |
| `api_call`     | Invoke a catalogued operation using the configured account and return its HTTP status, selected headers and response data.                                                |

Use the canonical `METHOD /api/v4/path/{parameter}` identifier returned by search. A unique
OpenAPI `operationId` is also accepted; ambiguous aliases are refused. Discovery and description
make no API requests after normal session startup.

For example, list the authenticated user's conversations across teams, including DMs/groups:

```json
{
  "operation": "GET /api/v4/users/{user_id}/channels",
  "path": { "user_id": "me" }
}
```

Pass that object to `api_call`. Use `api_describe` to inspect the operation's supported query
parameters. Then use `get_channel_posts` for a selected channel's history.

### Request and response interface

| Argument          | Meaning                                                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `operation`       | Canonical operation ID or a unique alias. Arbitrary URLs and HTTP methods are not accepted.                                                                                                                  |
| `path`            | Unencoded path parameter values. Every placeholder is required; separators, encoded segments and traversal are refused.                                                                                      |
| `query`           | String/number/boolean values or arrays. Arrays use the declared style; unknown array parameters use repeated keys. False, zero and empty strings are preserved.                                              |
| `body`            | Any JSON root value. With multipart uploads, an object of text fields; array values become repeated fields and object values are JSON-encoded.                                                               |
| `files`           | Multipart parts with `field`, exactly one of `file_path`/`content_base64`, optional `content_type`, and `filename` (required for inline content; defaults to the local basename). Text fields precede files. |
| `body_base64`     | Inline raw binary bytes. Requires a catalogued binary request format; mutually exclusive with `body_file_path`, `body` and `files`.                                                                          |
| `body_file_path`  | Absolute server-local path for a raw binary upload, subject to the upload roots/byte limit. Mutually exclusive with `body_base64`, `body` and `files`.                                                       |
| `content_type`    | Optional choice from the operation's request formats. Multipart boundaries are generated automatically.                                                                                                      |
| `headers`         | Declared endpoint headers and supported conditional/download headers. Cannot override credentials, host or routing headers.                                                                                  |
| `max_bytes`       | Maximum decoded response bytes, including error bodies; default **1 MiB**. Request smaller pages or raise it explicitly for larger downloads.                                                                |
| `response_format` | `auto` (default), `json`, `text` or `base64`. Auto recognizes JSON with charset, NDJSON, text and binary media.                                                                                              |
| `confirm`         | Must be `true` for a destructive operation, together with `MM_ALLOW_DESTRUCTIVE=true`.                                                                                                                       |

Successful JSON, scalar and text responses return `{status, headers, data}`. Binary responses
return `{status, headers, body_base64, bytes}`, including empty binary bodies (`bytes: 0`).
HEAD, 204, 304 and other empty nonbinary responses return `data: null`. HTTP 4xx/5xx responses
become MCP tool errors that preserve the actual status and available server details.
Redirect responses include their status and `Location` header but are never followed. Response
headers exclude credentials and cookies. Outputs use compact JSON.

Local file inputs require [upload configuration](configuration.md#uploads). The configured
`MM_MAX_UPLOAD_BYTES` limit covers all decoded file/binary sources in one call; `max_bytes`
independently limits the response. Local paths are read by the MCP server without passing file
contents through the agent. Raw file bodies are accepted only for catalogued binary formats,
never as a substitute for a JSON body.

The generic interface validates operation/path/header/encoding boundaries. Mattermost validates
business fields and permissions; the upstream request schemas have known omissions, so unknown
JSON fields and query parameters remain usable. See the source corrections in the
[coverage report](api-coverage.md).

### Policy

`api_describe` reports each operation's write/destructive classification. Read-only mode permits
audited reads, including read-only POST searches. Mutating operations are never retried after
ambiguous network/server failures, including the API's mutating GET activation route. Generic
DELETE operations and security/admin mutations require destructive confirmation. Convenience
tools keep their existing, narrower policies.

`api_call` is refused whenever either team/channel allowlist is configured, because arbitrary
API responses and administrative operations cannot safely share the convenience tools' resource
filtering. The scoped convenience tools remain usable. Special-credential and local-socket
operations are discoverable with `available: false` and refused before HTTP.

## Messaging (13)

| Tool                 | Description                                                                         |
| -------------------- | ----------------------------------------------------------------------------------- |
| `post_message` ⚠️    | Post a message to a channel (optional `root_id`, `file_ids`, `props`).              |
| `reply_thread` ⚠️    | Reply within a thread (`root_id`).                                                  |
| `get_channel_posts`  | Paginated channel history (`page`/`per_page`, or `since`/`before`/`after` cursors). |
| `get_thread`         | A full server-visible thread, including threads longer than 60 posts.               |
| `get_post`           | A single post by id.                                                                |
| `search_posts`       | Full-text search within a team (`terms`, `is_or_search`).                           |
| `edit_post` ⚠️       | Update a post's message (patch — message field only).                               |
| `delete_post` 💥     | Delete a post.                                                                      |
| `send_dm` ⚠️         | Open/get a DM (2 users) or group DM (3–8 users) and post a message.                 |
| `pin_post` ⚠️        | Pin a post.                                                                         |
| `unpin_post` ⚠️      | Unpin a post.                                                                       |
| `add_reaction` ⚠️    | Add an emoji reaction (as the authenticated user).                                  |
| `remove_reaction` ⚠️ | Remove an emoji reaction.                                                           |

For `get_channel_posts`, `before` and `after` are mutually exclusive. `since` retrieves modified posts
and cannot be combined with either cursor or `page`/`per_page`; the server caps that response at
1,000 posts, so use paginated history for a complete backfill. For `send_dm`, supply only distinct
IDs of the other participants (one for a DM, two to seven for a group).

For a new channel post, omit `post_message.root_id` or pass an empty string. To reply, provide
the thread's root post ID.

## Channels & Teams (12)

| Tool                   | Description                                     |
| ---------------------- | ----------------------------------------------- |
| `list_teams`           | Teams the authenticated user belongs to.        |
| `list_channels`        | The user's channels in a team.                  |
| `get_channel`          | Channel metadata.                               |
| `create_channel` ⚠️    | Create a public (`O`) or private (`P`) channel. |
| `join_channel` ⚠️      | Join a channel (self).                          |
| `leave_channel` ⚠️     | Leave a channel (self).                         |
| `archive_channel` 💥   | Archive (soft-delete) a channel.                |
| `list_channel_members` | Members of a channel (paginated).               |
| `add_member` ⚠️        | Add another user to a channel.                  |
| `remove_member` 💥     | Remove another user from a channel.             |
| `get_unreads`          | Per-channel unread/mention counts for a team.   |
| `mark_channel_read` ⚠️ | Mark a channel as viewed.                       |

`get_unreads` returns the server's unread counts, not the membership's already-read message
baseline. It makes one membership request plus one unread-count request per permitted channel.

## Users & Presence (6)

| Tool                   | Description                                                |
| ---------------------- | ---------------------------------------------------------- |
| `get_me`               | The authenticated user.                                    |
| `get_user`             | A user by id or username (exactly one required).           |
| `search_users`         | Search users by term.                                      |
| `get_user_status`      | A user's status (`online`/`away`/`dnd`/`offline`).         |
| `set_status` ⚠️        | Set own status (`online \| away \| offline \| dnd`).       |
| `set_custom_status` ⚠️ | Set own emoji/text, with optional duration and expiration. |

For an expiring custom status, provide a supported `duration` together with a future RFC3339
`expires_at` timestamp. Omitting both keeps the status until it is changed. The server validates
expiration against its own clock.

## Files (3)

| Tool                | Description                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `upload_file` ⚠️    | Upload inline base64 or a server-local file; returns metadata and file ids to attach via `post_message.file_ids`. |
| `get_file`          | Download a file's content as base64 (configurable `max_bytes` cap, default 8 MiB).                                |
| `get_file_metadata` | File info (`GET /files/{id}/info`).                                                                               |

`upload_file` takes `channel_id` and exactly one of `file_path` or `content_base64`.
For local files, `filename` defaults to the path's basename; supply it to rename the attachment.
Inline uploads require `filename` and canonical base64, including padding when required.
Both sources accept optional `content_type`. Successful uploads return only an array of
`{id, name, size, mime_type}` objects.

With `/srv/agent-uploads` in `MM_UPLOAD_ROOTS`, this uploads without putting file contents into
MCP arguments or results:

```json
{
  "channel_id": "RESOLVED_CHANNEL_ID",
  "file_path": "/srv/agent-uploads/report.pdf"
}
```

The file must exist on the MCP server, not merely on the agent's machine. Local reads are
disabled by default; see [upload configuration](configuration.md#uploads) for roots and limits.
An upload alone does not post a message. Attach returned IDs through `post_message.file_ids`
when sending is authorized. If a confidential upload is blocked by an old runtime or unavailable
path, report that missing capability; do not print contents/base64 through another tool.

Download limits apply to decoded bytes and error bodies. Metadata and upload responses are
capped at 1 MiB. Convenience upload, metadata and download requests reject HTTP redirects.

## Personal-account workflows

- Find someone with `get_user` or `search_users`, then pass their ID to `send_dm`.
- Read an existing conversation with `get_channel_posts`; use `get_thread` for replies.
- `list_channels` requires a team ID. Use the full-API example above for cross-team conversations.
- `join_channel`, `leave_channel`, `add_member` and `remove_member` use ordinary public/private
  channel membership endpoints. They do not change the participant set of an existing DM/group DM.
  `send_dm` opens the conversation for the exact participant set you supply.
- Upload a file with `upload_file`, then attach its returned ID with `post_message.file_ids`.

The MCP `tools/list` response contains the 37 tool schemas. Endpoint schemas are returned through
`api_describe`; the [coverage audit](api-coverage.md) defines the version and transport boundaries.
