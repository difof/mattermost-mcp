# Mattermost v11 API coverage

## Answer

This server exposes **34 MCP tools covering 33 distinct Mattermost REST operations**.
It covers common personal messaging workflows: identify users, send direct and group
messages, read channel history and threads, search a team, manage ordinary channel
membership, react, manage read state, and transfer files. It does **not** expose the
entire Mattermost API, including many operations available to ordinary accounts.

The audited Mattermost source registers **596 core REST operations**. This is an API
inventory, not a claim that a personal access token can call all 596 operations.
Using your own PAT authenticates requests as your account. Your permissions,
memberships, server policies and enabled features still determine what succeeds.
Mattermost documents PATs as an alternative to session credentials, with the
privileges of their owning account. [PAT authentication][pat]

For an agent using a personal account, the most useful remaining areas are discovery
across teams, channel lookup/search, reactions and pinned-message retrieval, global
message search, thread follow/read controls, preferences, drafts and scheduling.
No missing operations were implemented as part of this audit.

## Version and counting method

This audit targets **Mattermost Server v11.11.1**, released September 24, 2026, at
commit **`3acb3a7f684d11ccfcec4e5bd11c79f64e3eabf9`**. The source is pinned to that
commit rather than the moving online API reference. The OpenAPI document's
`info.version: 4.0.0` identifies the API, not the Mattermost server release.
[Release history][changelog] · [Pinned OpenAPI fragments][spec] ·
[Pinned core router source][server]

| Measure                                            | Count | Meaning                                                                                    |
| -------------------------------------------------- | ----: | ------------------------------------------------------------------------------------------ |
| Exposed MCP tools                                  |    34 | Registered definitions in the four tool modules.                                           |
| Covered REST operations                            |    33 | A tool supports at least one request to this method/path.                                  |
| Core HTTP REST operations registered by Mattermost |   596 | Includes conditional registrations and privileged or special-authentication routes.        |
| Documented `/api/v4` REST operations               |   594 | Includes five operations that the pinned server only exposes through its local socket API. |
| Operations both documented and registered for HTTP |   589 | Intersection of the preceding two inventories.                                             |
| Registered HTTP operations absent from OpenAPI     |     7 | Discoverable private-channel join-request routes.                                          |
| Documented local-socket-only operations            |     5 | Preserved in the inventory, excluded from the HTTP count.                                  |

The [complete inventory](api-coverage.json) contains **601 comparison records**:
596 registered HTTP operations plus the five documented local-only operations.
Every record identifies its method/path, available OpenAPI operation ID and source,
available server handler and authentication wrapper, permission references, and
MCP tool mapping. Missing `mcp_tools` means the route is not exposed by a tool.

Counting uses a unique **HTTP method + normalized path**. Different query parameters
or request bodies do not create additional operations. Mattermost's `me` user alias
and differing names for equivalent path parameters are normalized. The server's
`teams|channels` group-sync route alternatives are expanded into separate paths.

The 56 OpenAPI source fragments contain 600 operations before exclusions: five paths
outside `/api/v4`, one WebSocket upgrade operation, and the 594 REST operations above.
WebSocket behavior, `/api/v5`, root-level APIs, plugin-defined APIs, local socket
operations and the catch-all 404 handler are outside the HTTP coverage denominator.
Core endpoints that manage or delegate to plugins remain in the inventory; arbitrary
APIs installed by plugins do not. Conditional registrations are included even when a
particular deployment disables them.

**This snapshot does not establish compatibility with every v11 minor release.**
Some routes and options arrived during v11. The JSON retains minimum-version notes
where the pinned OpenAPI supplies them; absence of that field does not establish
availability on early v11 releases. Consult the actual server version and its
matching source before adding a new tool.

## What a personal access token permits

There are several separate checks between a tool call and a successful operation:

| Check                            | Consequence for a personal agent                                                                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credential                       | A valid PAT identifies its owner. It does not elevate that account or grant membership. PAT creation itself can be disabled or restricted by administrators.                                      |
| Account and resource permissions | Reading, posting, editing, deleting, inviting and managing channels have separate checks. Acting on your own resources can differ from acting on another user's resources.                        |
| Deployment features              | Licenses, configuration, feature flags, retention/access policies and installed integrations can restrict a route or its response.                                                                |
| MCP configuration                | Read-only mode, destructive-action confirmation, team/channel allowlists and payload limits further restrict the subset this server exposes. See the [configuration reference](configuration.md). |

For example, the channel-member endpoint distinguishes joining a public channel
from adding someone else and from managing a private channel. A PAT does not make
these interchangeable. Direct and group message creation also checks the actor's
permissions and permitted participants. [Channel handlers][channel-source]

The special `post:all` and `post:channels` account roles broaden posting access;
they should not be interpreted as blanket reading or administration privileges.
An administrator's PAT carries that account's elevated permissions. [PAT roles][pat]

The source has **564 operations using a session-required wrapper**, **26 using an
`APIHandler` variant**, and **6 using special credentials**: five remote-cluster
token operations and one Cloud API key webhook. These are authentication-wrapper
counts, **not counts of operations available to an ordinary PAT**. A session
wrapper still invokes handler and application permission checks. An `APIHandler`
route may require a password, reset token, integration token or other input even
though the wrapper does not require a session. Remote-cluster and Cloud service
credentials are separate from a user's PAT. [Authentication wrappers][handlers]

The inventory's `documented_permission_terms`, `server_permission_constants`,
`server_config_references` and `registration_feature_flags` are **source references**.
They are not a computed permission policy: alternatives, ownership checks, helper
functions and application-layer enforcement are not evaluated. In particular, a
missing permission list does not mean unrestricted access, and a list of feature
flags does not mean every listed flag must be enabled.

## Supported routes

All paths in this table are relative to `/api/v4`. The mapping comes from the current
tool handlers and the installed `@mattermost/client` implementation, checked against
the pinned OpenAPI and server registrations. Reused operations explain why 34 tools
map to 33 routes. The [JSON inventory](api-coverage.json) records hashes of the four
tool source files so changes to the audited implementation can be detected.

| Method and path                                                  | MCP tools                                      |
| ---------------------------------------------------------------- | ---------------------------------------------- |
| `GET /users/{user_id}`                                           | `get_me`, `get_user` by ID                     |
| `GET /users/username/{username}`                                 | `get_user` by username                         |
| `POST /users/search`                                             | `search_users`                                 |
| `GET /users/{user_id}/status`                                    | `get_user_status`                              |
| `PUT /users/{user_id}/status`                                    | `set_status` for the authenticated user        |
| `PUT /users/{user_id}/status/custom`                             | `set_custom_status` for the authenticated user |
| `POST /posts`                                                    | `post_message`, `reply_thread`, `send_dm`      |
| `GET /channels/{channel_id}/posts`                               | `get_channel_posts`                            |
| `GET /posts/{post_id}/thread`                                    | `get_thread`                                   |
| `GET /posts/{post_id}`                                           | `get_post`                                     |
| `POST /teams/{team_id}/posts/search`                             | `search_posts`                                 |
| `PUT /posts/{post_id}/patch`                                     | `edit_post`                                    |
| `DELETE /posts/{post_id}`                                        | `delete_post`                                  |
| `POST /channels/direct`                                          | `send_dm` for one recipient                    |
| `POST /channels/group`                                           | `send_dm` for multiple recipients              |
| `POST /posts/{post_id}/pin`                                      | `pin_post`                                     |
| `POST /posts/{post_id}/unpin`                                    | `unpin_post`                                   |
| `POST /reactions`                                                | `add_reaction`                                 |
| `DELETE /users/{user_id}/posts/{post_id}/reactions/{emoji_name}` | `remove_reaction` for the authenticated user   |
| `GET /users/{user_id}/teams`                                     | `list_teams`                                   |
| `GET /users/{user_id}/teams/{team_id}/channels`                  | `list_channels`                                |
| `GET /channels/{channel_id}`                                     | `get_channel`                                  |
| `POST /channels`                                                 | `create_channel`                               |
| `POST /channels/{channel_id}/members`                            | `join_channel`, `add_member`                   |
| `DELETE /channels/{channel_id}/members/{user_id}`                | `leave_channel`, `remove_member`               |
| `DELETE /channels/{channel_id}`                                  | `archive_channel`                              |
| `GET /channels/{channel_id}/members`                             | `list_channel_members`                         |
| `GET /users/{user_id}/teams/{team_id}/channels/members`          | `get_unreads`: enumerate memberships           |
| `GET /users/{user_id}/channels/{channel_id}/unread`              | `get_unreads`: retrieve unread counts          |
| `POST /channels/members/{user_id}/view`                          | `mark_channel_read`                            |
| `POST /files`                                                    | `upload_file`                                  |
| `GET /files/{file_id}`                                           | `get_file`                                     |
| `GET /files/{file_id}/info`                                      | `get_file_metadata`                            |

Authentication/bootstrap helpers are not additional exposed tools. For example,
password login uses `/users/login`, while startup and permission resolution reuse
existing user/channel/post/file lookup routes. There is no generic tool that lets
an agent call an arbitrary Mattermost endpoint.

### Route coverage is narrower than the full API contract

The tools intentionally expose selected parameters and responses:

- `search_users` exposes a search term, without the API's broader filtering options.
  `search_posts` requires a nonempty team ID and exposes terms and OR/AND selection;
  it does not expose global search or result pagination. An empty team ID is rejected
  instead of allowing the SDK to switch to `/posts/search`.
- `get_channel_posts` supports page, before, after and since selectors, with
  incompatible combinations rejected. The `since` endpoint returns modified posts
  and is limited to 1,000 posts; it is not a complete-history cursor. `get_thread`
  requests all retained, accessible thread posts by omitting `perPage`, avoiding
  the SDK's default 60-post page. It does not expose the API's thread pagination
  parameters. [Post reference][posts-spec] · [Thread handler][post-source]
- `set_custom_status` accepts the server's supported duration values and an optional RFC3339
  `expires_at`. A nonempty duration requires that timestamp; the server does not calculate it
  from the duration name. The server rejects past expiration times. [Status validation][custom-status]
- `edit_post` patches message text. `create_channel` exposes basic public/private
  channel creation, without the wider channel configuration fields.
- `send_dm` opens or creates a conversation and sends a message. It supports one to
  seven distinct recipients, excluding the authenticated account. Channel creation
  succeeds before posting, so a later posting failure can leave the conversation
  present; the workflow is not an atomic transaction.
- Channel membership tools use the channel-member API. That API rejects ordinary
  membership additions to direct/group conversations. Mattermost group membership
  changes involve a new conversation; they are not equivalent to adding a member
  to an existing private channel. [Channel handlers][channel-source]
- `get_file` returns base64 bytes with an 8 MiB default response limit. Uploads return
  selected file metadata. Preview, thumbnail, HEAD, file search and resumable-upload
  operations are not covered by those tools.

Allowlisted runs are narrower still. A team allowlist excludes teamless DMs/group
messages; a channel allowlist blocks creation/opening of a conversation whose ID
cannot be checked beforehand. Posting into an explicitly allowed existing channel
can use `post_message`, subject to the configured restrictions and server permissions.

## Missing capabilities relevant to a personal account

These are **candidates for a personal agent**, not promises that every non-admin
account can use them. Examples below exist in the pinned server and are not mapped
to tools. The inventory supplies the exact source for every method/path. All paths
are relative to `/api/v4`.

| Capability                           | Examples of missing routes                                                                                                                                 | Permission or feature considerations                                                                                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery across the account         | `GET /users/{user_id}/channels`; `POST /channels/group/search`                                                                                             | The all-teams route can operate as the authenticated user without supplying a team. Group searches remain subject to the user's visibility.                          |
| Channel lookup and browsing          | `GET /teams/{team_id}/channels`; `GET /teams/{team_id}/channels/name/{channel_name}`; `POST /teams/{team_id}/channels/search`                              | Public-channel discovery differs from membership and private-channel access.                                                                                         |
| Team navigation and membership       | `GET /teams/{team_id}`; `GET /teams/name/{team_name}`; `GET`/`POST /teams/{team_id}/members`; `DELETE /teams/{team_id}/members/{user_id}`                  | Joining, leaving, inviting and managing others have different team permissions.                                                                                      |
| Channel details and notifications    | `PUT /channels/{channel_id}/patch`; `PUT /channels/{channel_id}/members/{user_id}/notify_props`                                                            | Changing channel properties differs from changing your own notification settings.                                                                                    |
| Conversation conversion              | `GET /channels/{channel_id}/common_teams`; `POST /channels/{channel_id}/convert_to_channel`                                                                | Group-to-private-channel conversion needs the relevant membership, common team and channel-creation permissions.                                                     |
| More message retrieval and search    | `GET /channels/{channel_id}/pinned`; `GET /posts/{post_id}/reactions`; `POST /posts/ids`; `POST /posts/search`; `GET /posts/{post_id}/files/info`          | Reads and searches remain constrained by channel access and server search settings.                                                                                  |
| Unread and reminder controls         | `POST /users/{user_id}/posts/{post_id}/set_unread`; `POST /users/{user_id}/posts/{post_id}/reminder`                                                       | These concern the authenticated user's read/reminder state; some features can be disabled.                                                                           |
| Thread inbox and following           | `GET /users/{user_id}/teams/{team_id}/threads`; `PUT`/`DELETE /users/{user_id}/teams/{team_id}/threads/{thread_id}/following`; thread read-state routes    | Separate from fetching the messages in a thread. Ownership, team access and thread visibility matter.                                                                |
| Preferences and sidebar organization | `GET`/`PUT /users/{user_id}/preferences`; `/users/{user_id}/teams/{team_id}/channels/categories` operations                                                | Often useful for saved-message state and personal navigation; changes to other users' settings require additional permission.                                        |
| Profile and presence details         | `PUT /users/{user_id}/patch`; `POST /users/{user_id}/image`; `POST /users/status/ids`; `DELETE /users/{user_id}/status/custom`                             | Own-profile operations can be restricted by authentication source and server policy.                                                                                 |
| Drafts and scheduled messages        | `POST /drafts`; `GET /users/{user_id}/teams/{team_id}/drafts`; `POST /posts/schedule`; `GET /posts/scheduled/team/{team_id}`; scheduled-post update/delete | Draft synchronization and scheduling must be available/enabled; posting rights and ownership still apply.                                                            |
| Additional file operations           | `GET /files/{file_id}/preview`; `GET /files/{file_id}/thumbnail`; `POST /teams/{team_id}/files/search`; `POST /uploads`; `GET`/`POST /uploads/{upload_id}` | Download permissions, file policies and upload-session ownership apply.                                                                                              |
| Emoji and integration interaction    | `GET /emoji`; `POST /commands/execute`; `POST /posts/{post_id}/actions/{action_id}`                                                                        | Custom emoji, slash commands and interactive actions depend on permissions and installed/enabled integrations. Execution is distinct from provisioning integrations. |

Further unwrapped v11 areas include channel bookmarks, views, custom user groups,
custom profile attributes, message acknowledgements/edit history, recaps and newer
feature-specific operations. Their existence in the API is not evidence that the
deployment licenses or enables them. Custom user groups under `/groups` are also
different resources from group-message channels under `/channels/group`.

## Administrative and special-purpose areas

The inventory also includes account administration; roles and schemes; server
configuration and logs; jobs; license operations; LDAP/SAML configuration;
compliance, retention and import/export; access-control policies and content
flagging; clustering, shared channels and remote clusters; Cloud billing/service
integration; plugin administration; and webhook/OAuth/slash-command provisioning.

These areas are not exposed by the current tool set. Many require system or
delegated administration, ownership of an integration, a license, a feature setting,
or a different credential. Some read operations within these areas can be available
to ordinary accounts, so an entire category should not be labeled “admin only.”
They are outside this project's present messaging-focused scope. See
[project scope](../CLAUDE.md) and the per-operation inventory before planning an
extension.

### Source/reference differences retained by this audit

The seven server-only operations are the `GET`/`POST`/`DELETE`
`/channels/{channel_id}/join_request` routes, listing/counting/patching channel join
requests, and listing a user's join requests. Their registrations depend on
`FeatureFlags.DiscoverableChannels`; they are not a general way to enter any private
channel. [Join-request source][join-requests]

Five documented operations are registered only on the local socket router:
`DELETE /users`, `POST /config/migrate`, `POST /integrity`,
`POST /plugins/reattach`, and `POST /plugins/{plugin_id}/detach`. The JSON labels
these `local_socket_only` and records their local handler locations. A normal PAT
request over the server's HTTP API does not expose these local administrative
operations. [Local router][api-init] · [Local plugin routes][plugin-local]

## What the tests establish

The [mocked integration suite](../src/integration/mocked/) contains **32 tests**
covering successful calls to **all 34 exposed tools** through the MCP transport,
tool registry, real `Client4`, and a strict local HTTP fixture. It checks HTTP methods,
paths, query strings, JSON bodies and PAT authorization headers, plus multipart
uploads and binary downloads.

The workflows exercise both user lookup routes, direct/group creation, both unread
route types, each history selector, and a 75-post thread with `perPage` omitted.
Error scenarios exercise API-error propagation and selected local guardrails. These
mocks do **not** emulate Mattermost's authorization engine, licenses, feature flags,
retention behavior, persistence, WebSocket delivery or a live deployment.

Thus “all tools have mocked workflow coverage” does not mean “all Mattermost routes,
parameters or permission combinations are tested.” A live PAT integration run is a
separate check against a specific account and deployment.

```sh
npm run test:mocks
```

## Reproduce or update the inventory

[scripts/audit-api-coverage.py](../scripts/audit-api-coverage.py) is an audit utility,
not part of the MCP runtime. It requires Python 3.10+ and PyYAML. It adds no npm or
runtime dependency. For example:

```sh
python3 -m venv /tmp/mattermost-api-audit-venv
/tmp/mattermost-api-audit-venv/bin/pip install PyYAML
/tmp/mattermost-api-audit-venv/bin/python scripts/audit-api-coverage.py \
  --download --cache /tmp/mattermost-v11-api-source --check
```

`--download` uses immutable commit URLs and checks the downloaded/cached bytes
against the Git blob IDs supplied by that commit's GitHub directory listings.
For a local source checkout, use `--source /path/to/mattermost`; the script rejects
a different HEAD or changed/untracked API source files. Omit `--check` to regenerate
the JSON. Use Prettier after generation to preserve repository formatting.

The script parses the pinned source's literal route registrations, rejects
unrecognized registration syntax, normalizes equivalent paths, compares the two
inventories, and validates the explicit mapping against the current tool names.
Source-file hashes and wrapper counts are included in the output. A future server
version or tool change needs review of the pin, parsing assumptions and mapping;
changing a version label alone is not a new audit.

[pat]: https://docs.mattermost.com/developers/integrate/reference/personal-access-token
[changelog]: https://docs.mattermost.com/product-overview/mattermost-v11-changelog
[spec]: https://github.com/mattermost/mattermost/tree/3acb3a7f684d11ccfcec4e5bd11c79f64e3eabf9/api/v4/source
[server]: https://github.com/mattermost/mattermost/tree/3acb3a7f684d11ccfcec4e5bd11c79f64e3eabf9/server/channels/api4
[api-init]: https://github.com/mattermost/mattermost/blob/3acb3a7f684d11ccfcec4e5bd11c79f64e3eabf9/server/channels/api4/api.go
[handlers]: https://github.com/mattermost/mattermost/blob/3acb3a7f684d11ccfcec4e5bd11c79f64e3eabf9/server/channels/api4/handlers.go
[channel-source]: https://github.com/mattermost/mattermost/blob/3acb3a7f684d11ccfcec4e5bd11c79f64e3eabf9/server/channels/api4/channel.go
[posts-spec]: https://github.com/mattermost/mattermost/blob/3acb3a7f684d11ccfcec4e5bd11c79f64e3eabf9/api/v4/source/posts.yaml
[post-source]: https://github.com/mattermost/mattermost/blob/3acb3a7f684d11ccfcec4e5bd11c79f64e3eabf9/server/channels/api4/post.go
[join-requests]: https://github.com/mattermost/mattermost/blob/3acb3a7f684d11ccfcec4e5bd11c79f64e3eabf9/server/channels/api4/channel_join_request.go
[plugin-local]: https://github.com/mattermost/mattermost/blob/3acb3a7f684d11ccfcec4e5bd11c79f64e3eabf9/server/channels/api4/plugin_local.go
[custom-status]: https://github.com/mattermost/mattermost/blob/3acb3a7f684d11ccfcec4e5bd11c79f64e3eabf9/server/public/model/custom_status.go
