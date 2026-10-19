# Conversation workflows

## Find existing personal conversations

Use the following read operations through `api_call` after describing the required schemas.
These are API arguments, independent of the harness's tool-call syntax.

| Purpose                                         | Arguments                                                                                    |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| All joined conversations across teams           | `{operation: "GET /api/v4/users/{user_id}/channels", path: {user_id: "me"}}`                 |
| Profiles for known user IDs                     | `{operation: "POST /api/v4/users/ids", body: ["USER_ID"]}`                                   |
| Profiles for exact usernames                    | `{operation: "POST /api/v4/users/usernames", body: ["USERNAME"]}`                            |
| Participants in existing group channels         | `{operation: "POST /api/v4/users/group_channels", body: ["GROUP_CHANNEL_ID"]}`               |
| People in one candidate channel                 | `{operation: "GET /api/v4/users", query: {in_channel: "CHANNEL_ID", page: 0, per_page: 60}}` |
| Existing groups matching a participant username | `{operation: "POST /api/v4/channels/group/search", body: {term: "USERNAME"}}`                |

Replace uppercase placeholders with resolved values. The joined-conversations endpoint has no
`page`/`per_page` arguments. Filter its result locally: `D` means direct, `G` group, `O` public,
`P` private. Select candidate conversations before fetching histories. Verify the participant set
when names overlap; a group display name alone is insufficient. Bulk group lookup returns
`{channelId: [User, ...]}`; skip an empty input array. Deduplicate IDs and chunk large profile lookups
to the described/deployed limits.

`send_dm` opens or gets a channel **and sends a post**. Never use it only to locate a conversation
or read existing personal messages. Joining a public channel or changing sidebar/read preferences
is also a separate write, not a required step for listing accessible history.

## Read history and search

Start with `get_channel_posts({channel_id, per_page: 40})`. A PostList is `{order, posts}`;
use `order.map(id => posts[id])`, not object insertion order. Posts carry epoch **millisecond**
timestamps. Preserve IDs, author IDs, channel IDs and `root_id` with relevant text.

For older history, take the oldest returned ID from `order` and request
`get_channel_posts({channel_id, before: oldestId, per_page: 40})`. Read dependent pages sequentially;
deduplicate post IDs and stop at the requested cutoff, an empty page, no cursor progress, or an
explicit page budget. Keep the last cursor and report whether the requested interval was reached.
Do not treat a single page or a filtered empty result as proof that older history is empty.

`before` and `after` are exclusive alternatives. `since` cannot combine with either or with
`page`/`per_page`; it returns **modified** posts, capped at 1,000 with possible gaps. Use it for
incremental checks, not a guaranteed complete creation-time backfill.

For a thread, resolve the root with `post.root_id || post.id`, then use `get_thread`.
That convenience tool fetches the full accessible thread. For a very large thread, describe
`GET /api/v4/posts/{post_id}/thread` and page it; its query names are `perPage`, `fromPost` and
`fromCreateAt`, unlike channel history. Avoid loading whole threads when a few posts answer the task.

`search_posts` is team scoped. Use operation discovery for global/richer search and its actual
paging contract; search capabilities vary by server. Prefer server search for a specific topic,
then read matching context. `get_unreads` makes a membership request plus one request per channel;
do not mistake it for a cheap bulk history call or mark channels read while summarizing them.

## Send, reply and manage participants

| Requested action                          | Workflow                                                                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Send to a known conversation              | `post_message({channel_id, message})`                                                                            |
| Send to a resolved person or new group    | `send_dm({user_ids: [otherUserId, ...], message})`                                                               |
| Reply to a post                           | Read it and resolve its root, then `reply_thread({channel_id: post.channel_id, root_id: rootId, message})`       |
| Join or change regular channel membership | Resolve the channel and user; inspect membership; call the matching join/add/remove tool for the requested delta |

`send_dm.user_ids` contains **only the other participants**, unique, one to seven. Do not include
the authenticated user's ID. Existing group-DM participant sets are fixed; regular channel
membership tools do not add people to those groups. Creating a different group is a separate
conversation, so make that effect clear when the user asks to change group participants.

For an explicitly requested self-DM, `send_dm` is not the right convenience tool. Describe
`POST /api/v4/channels/direct`, create/get it with `[me.id, me.id]` if the deployment supports it,
then post to the returned channel. Never silently redirect a message to a test or self channel.

After an uncertain send, read recent posts in the resolved channel and compare the author,
text, thread root, attachments and time window. A possible match is not certainty. If the result
cannot be reconciled, report the uncertainty instead of blindly sending again. Sequence writes
whose later inputs or meaning depend on earlier results; a multi-step workflow is not atomic.
