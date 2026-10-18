import { describe, expect, it } from "vitest";
import { ME, PEER, OK, useMattermost } from "./mattermost-http-fixture.js";
const THREAD_FLAGS = {
  skipFetchThreads: false,
  collapsedThreads: false,
  collapsedThreadsExtended: false,
};
describe("personal messaging through MCP and the Mattermost HTTP API", () => {
  const fixture = useMattermost({ guardrails: { allowDestructive: true } });
  it("advertises all 37 tools with schemas and accurate write/destructive hints", async () => {
    const { tools } = await fixture().listTools();
    const readTools = [
      "api_search",
      "api_describe",
      "get_me",
      "get_user",
      "search_users",
      "get_user_status",
      "get_channel_posts",
      "get_thread",
      "get_post",
      "search_posts",
      "list_teams",
      "list_channels",
      "get_channel",
      "list_channel_members",
      "get_unreads",
      "get_file",
      "get_file_metadata",
    ];
    const writeTools = [
      "api_call",
      "set_status",
      "set_custom_status",
      "post_message",
      "reply_thread",
      "edit_post",
      "delete_post",
      "send_dm",
      "pin_post",
      "unpin_post",
      "add_reaction",
      "remove_reaction",
      "create_channel",
      "join_channel",
      "leave_channel",
      "archive_channel",
      "add_member",
      "remove_member",
      "mark_channel_read",
      "upload_file",
    ];
    expect(tools.map(({ name }) => name).sort()).toEqual([...readTools, ...writeTools].sort());
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.properties).toBeTypeOf("object");
      expect(tool.description).toBeTruthy();
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(readTools.includes(tool.name));
      expect(tool.annotations?.destructiveHint, tool.name).toBe(
        ["api_call", "delete_post", "archive_channel", "remove_member"].includes(tool.name),
      );
    }
    const dm = tools.find(({ name }) => name === "send_dm");
    expect(dm.inputSchema.required).toEqual(["user_ids", "message"]);
  });
  it("identifies the PAT owner, resolves colleagues, and updates the owner's presence", async () => {
    const mm = fixture();
    mm.expect("GET", "/users/me", { reply: ME });
    expect(await mm.call("get_me")).toEqual(ME);
    mm.expect("GET", `/users/username/${PEER.username}`, { reply: PEER });
    expect(await mm.call("get_user", { username: PEER.username })).toEqual(PEER);
    mm.expect("GET", `/users/${PEER.id}`, { reply: PEER });
    expect(await mm.call("get_user", { user_id: PEER.id })).toEqual(PEER);
    mm.expect("POST", "/users/search", { body: { term: "rob" }, reply: [PEER] });
    expect(await mm.call("search_users", { term: "rob" })).toEqual([PEER]);
    mm.expect("POST", "/users/search", { body: { term: "nobody" }, reply: [] });
    expect(await mm.call("search_users", { term: "nobody" })).toEqual([]);
    const presence = { user_id: PEER.id, status: "online", manual: false, last_activity_at: 100 };
    mm.expect("GET", `/users/${PEER.id}/status`, { reply: presence });
    expect(await mm.call("get_user_status", { user_id: PEER.id })).toEqual(presence);
    const status = { user_id: ME.id, status: "dnd" };
    mm.expect("PUT", `/users/${ME.id}/status`, { body: status, reply: status });
    expect(await mm.call("set_status", { status: "dnd" })).toEqual(status);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const offsetExpiry = new Date(Date.now() + 3 * 60 * 60 * 1000)
      .toISOString()
      .replace("Z", "+02:00");
    const expirations = [
      {},
      { duration: "today", expires_at: expiresAt },
      { duration: "", expires_at: offsetExpiry },
      { expires_at: expiresAt },
    ];
    for (const expiration of expirations) {
      const custom = { emoji: "calendar", text: "Planning", ...expiration };
      mm.expect("PUT", "/users/me/status/custom", {
        body: { ...custom, duration: expiration.duration ?? "" },
      });
      expect(await mm.call("set_custom_status", custom)).toEqual(OK);
    }
  });
  it("opens an existing DM or a group with raw participant arrays and sends as the PAT owner", async () => {
    const mm = fixture();
    for (const [kind, recipients] of [
      ["direct", [PEER.id]],
      ["group", [PEER.id, "another-colleague"]],
    ]) {
      const channel = { id: `${kind}-channel`, type: kind === "direct" ? "D" : "G", team_id: "" };
      const message = `Hello ${kind}`;
      const post = { id: `${kind}-post`, channel_id: channel.id, user_id: ME.id, message };
      mm.expect("POST", `/channels/${kind}`, { body: [ME.id, ...recipients], reply: channel });
      mm.expect("POST", "/posts", { body: { channel_id: channel.id, message }, reply: post });
      expect(await mm.call("send_dm", { user_ids: [...recipients], message })).toEqual(post);
      const history = {
        order: [post.id],
        posts: { [post.id]: post },
        next_post_id: "",
        prev_post_id: "",
      };
      mm.expect("GET", `/channels/${channel.id}/posts`, {
        query: { page: 0, per_page: 60, ...THREAD_FLAGS },
        reply: history,
      });
      expect(await mm.call("get_channel_posts", { channel_id: channel.id })).toEqual(history);
    }
  });
  it("posts, reads, replies, edits, searches, reacts, and deletes without losing post fields", async () => {
    const mm = fixture();
    const args = {
      channel_id: "project-channel",
      message: "Draft plan",
      props: { project: "launch" },
    };
    const root = { ...args, id: "root-post", user_id: ME.id, create_at: 1000 };
    mm.expect("POST", "/posts", { body: args, reply: root });
    const posted = await mm.call("post_message", args);
    expect(posted).toEqual(root);
    mm.expect("GET", `/posts/${posted.id}`, { reply: root });
    expect(await mm.call("get_post", { post_id: posted.id })).toEqual(root);
    const replyArgs = { channel_id: posted.channel_id, root_id: posted.id, message: "More detail" };
    const reply = { ...replyArgs, id: "reply-post", user_id: ME.id };
    mm.expect("POST", "/posts", { body: replyArgs, reply });
    expect(await mm.call("reply_thread", replyArgs)).toEqual(reply);
    const edited = { ...root, message: "Final plan", edit_at: 2000 };
    mm.expect("PUT", `/posts/${posted.id}/patch`, {
      body: { id: posted.id, message: edited.message },
      reply: edited,
    });
    expect(await mm.call("edit_post", { post_id: posted.id, message: edited.message })).toEqual(
      edited,
    );
    const search = {
      order: [edited.id],
      posts: { [edited.id]: edited },
      matches: { [edited.id]: ["plan"] },
    };
    for (const isOr of [undefined, true]) {
      mm.expect("POST", "/teams/project-team/posts/search", {
        body: { terms: "plan launch", is_or_search: isOr ?? false },
        reply: search,
      });
      expect(
        await mm.call("search_posts", {
          team_id: "project-team",
          terms: "plan launch",
          ...(isOr == null ? {} : { is_or_search: isOr }),
        }),
      ).toEqual(search);
    }
    mm.expect("POST", `/posts/${posted.id}/pin`);
    expect(await mm.call("pin_post", { post_id: posted.id })).toEqual(OK);
    const reaction = { user_id: ME.id, post_id: posted.id, emoji_name: "thumbsup" };
    mm.expect("POST", "/reactions", { body: reaction, reply: reaction });
    expect(await mm.call("add_reaction", { post_id: posted.id, emoji_name: "thumbsup" })).toEqual(
      reaction,
    );
    mm.expect("DELETE", `/users/${ME.id}/posts/${posted.id}/reactions/thumbsup`);
    expect(
      await mm.call("remove_reaction", { post_id: posted.id, emoji_name: "thumbsup" }),
    ).toEqual(OK);
    mm.expect("POST", `/posts/${posted.id}/unpin`);
    expect(await mm.call("unpin_post", { post_id: posted.id })).toEqual(OK);
    mm.expect("DELETE", `/posts/${posted.id}`);
    expect(await mm.call("delete_post", { post_id: posted.id, confirm: true })).toEqual(OK);
  });
  it("retrieves an entire thread beyond the SDK's usual 60-post page", async () => {
    const mm = fixture();
    const posts = Object.fromEntries(
      Array.from({ length: 75 }, (_, i) => [
        `thread-post-${i}`,
        {
          id: `thread-post-${i}`,
          channel_id: "project-channel",
          root_id: i ? "thread-post-0" : "",
          message: `Reply ${i}`,
        },
      ]),
    );
    const thread = { order: Object.keys(posts), posts, next_post_id: "", prev_post_id: "" };
    mm.expect("GET", "/posts/thread-post-0/thread", {
      query: { ...THREAD_FLAGS, direction: "down" },
      reply: thread,
    });
    expect(await mm.call("get_thread", { post_id: "thread-post-0" })).toEqual(thread);
  });
  it.each([
    { name: "default page", args: {}, query: { page: 0, per_page: 60 } },
    { name: "explicit page", args: { page: 2, per_page: 25 }, query: { page: 2, per_page: 25 } },
    {
      name: "before cursor",
      args: { before: "cursor", page: 2, per_page: 25 },
      query: { before: "cursor", page: 2, per_page: 25 },
    },
    {
      name: "after cursor",
      args: { after: "cursor", page: 2, per_page: 25 },
      query: { after: "cursor", page: 2, per_page: 25 },
    },
    { name: "since zero", args: { since: 0 }, query: { since: 0 } },
  ])(
    "maps $name to an exact history query and preserves an empty result",
    async ({ args, query }) => {
      const mm = fixture();
      const empty = { order: [], posts: {}, next_post_id: "", prev_post_id: "" };
      mm.expect("GET", "/channels/project-channel/posts", {
        query: { ...THREAD_FLAGS, ...query },
        reply: empty,
      });
      expect(
        await mm.call("get_channel_posts", { channel_id: "project-channel", ...args }),
      ).toEqual(empty);
    },
  );
});
