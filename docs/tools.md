# Tool reference

[Back to README](../README.md) · [API coverage](api-coverage.md)

Legend: ⚠️ = write (blocked by `MM_READ_ONLY=true`) · 💥 = destructive (requires
`MM_ALLOW_DESTRUCTIVE=true` **and** `confirm: true` per call)

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
- `list_channels` requires a team ID. A cross-team conversation listing is not exposed yet.
- `join_channel`, `leave_channel`, `add_member` and `remove_member` use ordinary public/private
  channel membership endpoints. They do not change the participant set of an existing DM/group DM.
  `send_dm` opens the conversation for the exact participant set you supply.
- Upload a file with `upload_file`, then attach its returned ID with `post_message.file_ids`.

The MCP `tools/list` response contains each tool's complete input schema. These 34 tools expose a
subset of REST API v4; the [coverage audit](api-coverage.md) lists missing endpoints and options.
