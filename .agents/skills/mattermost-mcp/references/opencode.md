# OpenCode Code Mode

Read the section needed for the task:
[discovery](#discover-only-needed-tools), [results](#use-decoded-results),
[batched reads](#batch-selected-histories), [sending](#send-after-resolving-the-target),
[local uploads](#upload-a-local-file).

These examples target OpenCode v2 `execute`. Discover the server's actual namespace first;
`mattermost` below assumes that MCP server name. Each block is a separate execution, with no
variables carried between blocks. Replace uppercase placeholders with resolved values. Await all
calls before returning. The sandbox has no imports, filesystem access or timers; use configured
tools for operations and JavaScript for orchestration/filtering.

## Discover only needed tools

`search` is synchronous. Start with the tool needed for the task:

```js
return search({ namespace: "mattermost", query: "get_channel_posts", limit: 1 });
```

Discover generic API tools only when a convenience tool does not cover the task:

```js
return search({ namespace: "mattermost", query: "api_", limit: 3 });
```

Host `search` discovers MCP tools. `tools.mattermost.api_search` discovers REST operations inside
this server; these are different catalogs. Keep tool/schema discovery focused and reuse what is
already in context. If a search is empty, shorten the query or check the configured namespace.

```js
return await tools.mattermost.api_search({ query: "group search", limit: 5 });
```

Once an operation is selected, load its inputs before executing it:

```js
return await tools.mattermost.api_describe({
  operation: "GET /api/v4/users/{user_id}/channels",
  include_response: true,
});
```

## Use decoded results

OpenCode already decodes successful MCP JSON text. MCP errors become tool failures; handle them
with `try`/`catch` or `Promise.allSettled`. A User or Post is the object itself:

```js
const me = await tools.mattermost.get_me();
if (!me?.id) throw new Error("get_me did not return a user");
return { id: me.id, username: me.username };
```

Do not parse `me.content`, `me.data` or `JSON.parse(me)`. The generic API's HTTP envelope remains:

```js
const response = await tools.mattermost.api_call({
  operation: "GET /api/v4/users/{user_id}/channels",
  path: { user_id: "me" },
});
if (!Array.isArray(response?.data)) throw new Error("Expected a channel list");
const personal = response.data.filter((channel) => ["D", "G"].includes(channel.type));
return {
  total: personal.length,
  shown: personal.slice(0, 20).map(({ id, type, display_name }) => ({ id, type, display_name })),
  truncated: personal.length > 20,
};
```

Use a task-specific filter inside the block when possible. This example intentionally caps the
inventory returned to the model; it does not mean only 20 conversations exist.

## Batch selected histories

After selecting relevant channels, read independent first pages together and return a compact
packet. This example limits concurrency to four and preserves per-channel failures. Adapt the
overall channel/page budget to the task; never fetch every conversation's history by default.

```js
const channelIds = ["CHANNEL_ID_1", "CHANNEL_ID_2"];
const output = [];
for (let start = 0; start < channelIds.length; start += 4) {
  const batch = channelIds.slice(start, start + 4);
  const results = await Promise.allSettled(
    batch.map(async (channel_id) => {
      const page = await tools.mattermost.get_channel_posts({ channel_id, per_page: 40 });
      if (!Array.isArray(page?.order) || !page?.posts) throw new Error("Expected a PostList");
      const posts = page.order.map((id) => page.posts[id]).filter(Boolean);
      return {
        channel_id,
        fetched: posts.length,
        before: page.order.at(-1) ?? null,
        messages: posts.slice(0, 10).map(({ id, user_id, create_at, root_id, message }) => ({
          id,
          user_id,
          create_at,
          root_id,
          message: message.slice(0, 500),
          text_truncated: message.length > 500,
        })),
        omitted: posts.length > 10,
      };
    }),
  );
  results.forEach((result, index) => {
    output.push(
      result.status === "fulfilled"
        ? result.value
        : { channel_id: batch[index], error: String(result.reason) },
    );
  });
}
return { scope: "first page per selected channel; excerpts only", channels: output };
```

Choose relevant posts before projection; `slice` above demonstrates an explicit output budget.
The `before` cursor follows the **fetched** page, so retain/process omitted fetched posts locally
if doing a complete analysis. Do not skip them by resuming that cursor from only the shown excerpts.
For additional pages, follow the sequential history procedure in the conversation reference.
Resolve authors only if useful: deduplicate selected `user_id` values and make one bounded
`POST /api/v4/users/ids` lookup instead of one tool call per message.

## Send after resolving the target

For an explicitly requested message to an exact username, discover `get_user` and `send_dm`,
then resolve and send sequentially inside one execution:

```js
const user = await tools.mattermost.get_user({ username: "EXACT_USERNAME" });
if (!user?.id || user.username !== "EXACT_USERNAME") throw new Error("Recipient unresolved");
const post = await tools.mattermost.send_dm({
  user_ids: [user.id],
  message: "REQUESTED_MESSAGE",
});
if (!post?.id || !post.channel_id) throw new Error("Send outcome requires reconciliation");
return { id: post.id, channel_id: post.channel_id, message: post.message };
```

For an existing resolved channel, call `post_message` directly. Do not automatically replay this
block after a failure; use the conversation reference's reconciliation procedure.

## Upload a local file

Discover `upload_file` and confirm its schema includes `file_path`. After resolving the channel
and the requested file, pass the path directly. The example assumes `/srv/agent-uploads` is in
the MCP server's `MM_UPLOAD_ROOTS` and the file exists on that server; it needs no filesystem
access inside `execute`.

```js
const files = await tools.mattermost.upload_file({
  channel_id: "RESOLVED_CHANNEL_ID",
  file_path: "/srv/agent-uploads/report.pdf",
});
if (!Array.isArray(files) || files.length !== 1 || !files[0]?.id) {
  throw new Error("Upload outcome requires reconciliation");
}
return files.map(({ id, name, size, mime_type }) => ({ id, name, size, mime_type }));
```

This uploads only. Use the returned IDs in a later authorized `post_message` call; do not reload
the file or print base64. If the running MCP lacks path inputs, update/rebuild that installation
and restart its connection. If the file is not visible to the MCP process or outside its allowed
roots, report the missing mount/configuration without bypassing the confidentiality boundary.

## Host references

- [OpenCode v2 MCP configuration](https://dev.opencode.ai/v2/docs/mcp-servers/): `mcp.servers`,
  Code Mode enabled by default, namespaces and permission behavior.
- [Execute tool](https://dev.opencode.ai/v2/docs/tools/): JavaScript orchestration and sandbox limits.
- [Skill discovery](https://dev.opencode.ai/v2/docs/skills/): project/global skill locations and loading.
