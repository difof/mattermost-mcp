# Tool reference

[Back to README](../README.md) · [API coverage](api-coverage.md)

Legend: ⚠️ = write (blocked by `MM_READ_ONLY=true`) · 💥 = destructive (requires
`MM_ALLOW_DESTRUCTIVE=true` **and** `confirm: true` per call)

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

| Argument          | Meaning                                                                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operation`       | Canonical operation ID or a unique alias. Arbitrary URLs and HTTP methods are not accepted.                                                                     |
| `path`            | Unencoded path parameter values. Every placeholder is required; separators, encoded segments and traversal are refused.                                         |
| `query`           | String/number/boolean values or arrays. Arrays use the declared style; unknown array parameters use repeated keys. False, zero and empty strings are preserved. |
| `body`            | Any JSON root value. With multipart uploads, an object of text fields; array values become repeated fields and object values are JSON-encoded.                  |
| `files`           | Multipart file parts: `{field, filename, content_base64, content_type?}`. Text fields are written before file parts.                                            |
| `body_base64`     | Raw binary upload bytes, mutually exclusive with `body` and `files`. Requires a catalogued binary request format.                                               |
| `content_type`    | Optional choice from the operation's request formats. Multipart boundaries are generated automatically.                                                         |
| `headers`         | Declared endpoint headers and supported conditional/download headers. Cannot override credentials, host or routing headers.                                     |
| `max_bytes`       | Maximum decoded response bytes, including error bodies; default **1 MiB**. Request smaller pages or raise it explicitly for larger downloads.                   |
| `response_format` | `auto` (default), `json`, `text` or `base64`. Auto recognizes JSON with charset, NDJSON, text and binary media.                                                 |
| `confirm`         | Must be `true` for a destructive operation, together with `MM_ALLOW_DESTRUCTIVE=true`.                                                                          |

Successful JSON, scalar and text responses return `{status, headers, data}`. Binary responses
return `{status, headers, body_base64, bytes}`, including empty binary bodies (`bytes: 0`).
HEAD, 204, 304 and other empty nonbinary responses return `data: null`. HTTP 4xx/5xx responses
become MCP tool errors that preserve the actual status and available server details.
Redirect responses include their status and `Location` header but are never followed. Response
headers exclude credentials and cookies. Outputs use compact JSON.

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

| Tool                | Description                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| `upload_file` ⚠️    | Upload a file to a channel (base64 content); returns file ids to attach via `post_message.file_ids`. |
| `get_file`          | Download a file's content as base64 (configurable `max_bytes` cap, default 8 MiB).                   |
| `get_file_metadata` | File info (`GET /files/{id}/info`).                                                                  |

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
