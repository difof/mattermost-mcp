import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchFileMetadata } from "../mattermost/files.js";
import { allTools } from "./index.js";
import { dispatchToolCall } from "./registry.js";
vi.mock("../mattermost/files.js", async (original) => ({
  ...(await original()),
  fetchFileMetadata: vi.fn(),
}));
function fixture(guardrails = {}) {
  const client = {
    getChannel: vi.fn(async () => ({ id: "allowed", team_id: "team1" })),
    getPost: vi.fn(async () => ({ id: "post1", channel_id: "blocked" })),
    getPaginatedPostThread: vi.fn(),
    patchPost: vi.fn(async () => ({ id: "post1", channel_id: "allowed", message: "updated" })),
    deletePost: vi.fn(),
    pinPost: vi.fn(),
    unpinPost: vi.fn(),
    addReaction: vi.fn(),
    removeReaction: vi.fn(),
    createPost: vi.fn(async () => ({ id: "new-post" })),
    createChannel: vi.fn(async () => ({ id: "new-channel" })),
    createDirectChannel: vi.fn(),
    createGroupChannel: vi.fn(),
    getMyTeams: vi.fn(async () => [{ id: "team1" }, { id: "team2" }]),
    getMyChannels: vi.fn(async () => [
      { id: "allowed", team_id: "team1" },
      { id: "blocked", team_id: "team1" },
      { id: "other-team", team_id: "team2" },
      { id: "dm", team_id: "" },
    ]),
    searchPosts: vi.fn(async () => ({
      order: ["p1", "p2"],
      posts: {
        p1: { id: "p1", channel_id: "allowed", message: "visible" },
        p2: { id: "p2", channel_id: "blocked", message: "hidden" },
      },
      matches: { p1: ["visible"], p2: ["hidden"] },
      next_post_id: "p2",
      prev_post_id: "p1",
    })),
  };
  const session = {
    userId: "me",
    client: client,
    config: {
      url: "https://mm.test",
      auth: { mode: "pat", token: "test" },
      guardrails: {
        readOnly: false,
        allowDestructive: true,
        channelAllowlist: ["allowed"],
        teamAllowlist: [],
        maxMessageLen: 16383,
        ...guardrails,
      },
    },
    call: (fn) => fn(client),
  };
  return {
    client,
    call: (name, args = {}) => dispatchToolCall(allTools, { session }, name, args),
  };
}
function body(result) {
  return result.content[0].text;
}
beforeEach(() => vi.clearAllMocks());
describe("resolved resource allowlists", () => {
  it("resolves a channel's team before allowing a write", async () => {
    const { client, call } = fixture({ channelAllowlist: [], teamAllowlist: ["team2"] });
    const result = await call("post_message", { channel_id: "allowed", message: "hello" });
    expect(result.isError).toBe(true);
    expect(body(result)).toContain("MM_TEAM_ALLOWLIST");
    expect(client.createPost).not.toHaveBeenCalled();
  });
  it.each([
    ["get_post", {}],
    ["get_thread", {}],
    ["edit_post", { message: "updated" }],
    ["delete_post", { confirm: true }],
    ["pin_post", {}],
    ["unpin_post", {}],
    ["add_reaction", { emoji_name: "thumbsup" }],
    ["remove_reaction", { emoji_name: "thumbsup" }],
  ])("blocks %s using a post ID from another channel", async (tool, args) => {
    const { client, call } = fixture();
    const result = await call(tool, { post_id: "post1", ...args });
    expect(result.isError).toBe(true);
    expect(body(result)).toContain("MM_CHANNEL_ALLOWLIST");
    for (const method of [
      client.getPaginatedPostThread,
      client.patchPost,
      client.deletePost,
      client.pinPost,
      client.unpinPost,
      client.addReaction,
      client.removeReaction,
    ])
      expect(method).not.toHaveBeenCalled();
    expect(client.getPost).toHaveBeenCalledTimes(1);
  });
  it("allows an indirect write after resolving both channel and team", async () => {
    const { client, call } = fixture({ teamAllowlist: ["team1"] });
    client.getPost.mockResolvedValue({ id: "post1", channel_id: "allowed" });
    const result = await call("edit_post", { post_id: "post1", message: "updated" });
    expect(result.isError).toBeUndefined();
    expect(client.patchPost).toHaveBeenCalledTimes(1);
    expect(client.patchPost).toHaveBeenCalledWith({ id: "post1", message: "updated" });
  });
  it("checks the returned post when it moved outside the allowlist after preflight", async () => {
    const { client, call } = fixture();
    client.getPost.mockResolvedValue({ id: "post1", channel_id: "allowed" });
    client.patchPost.mockResolvedValue({
      id: "post1",
      channel_id: "blocked",
      message: "content outside the permitted channel",
    });
    const result = await call("edit_post", { post_id: "post1", message: "updated" });
    expect(result.isError).toBe(true);
    expect(body(result)).toContain("MM_CHANNEL_ALLOWLIST");
    expect(body(result)).not.toContain("content outside the permitted channel");
  });
  it.each([
    ["get_post", { post_id: "post1" }, "getPost"],
    ["get_channel", { channel_id: "allowed" }, "getChannel"],
    ["get_file_metadata", { file_id: "f1" }, "file"],
  ])("reuses %s preflight data only within the current tool call", async (name, args, method) => {
    const { client, call } = fixture({ teamAllowlist: ["team1"] });
    client.getPost.mockResolvedValue({ id: "post1", channel_id: "allowed" });
    vi.mocked(fetchFileMetadata).mockResolvedValue({ id: "f1", channel_id: "allowed" });
    const read = method === "file" ? fetchFileMetadata : client[method];
    expect((await call(name, args)).isError).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(1);
    expect((await call(name, args)).isError).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("does not introduce resource lookups when no allowlists are configured", async () => {
    const { client, call } = fixture({ channelAllowlist: [] });
    expect(
      (await call("edit_post", { post_id: "post1", message: "updated" })).isError,
    ).toBeUndefined();
    expect(client.getPost).not.toHaveBeenCalled();
    expect(client.getChannel).not.toHaveBeenCalled();
  });
  it.each(["get_file", "get_file_metadata"])(
    "blocks %s from a disallowed channel",
    async (name) => {
      vi.mocked(fetchFileMetadata).mockResolvedValue({ channel_id: "blocked" });
      const { call } = fixture();
      const result = await call(name, { file_id: "f1" });
      expect(result.isError).toBe(true);
      expect(body(result)).toContain("MM_CHANNEL_ALLOWLIST");
      expect(fetchFileMetadata).toHaveBeenCalledTimes(1);
    },
  );
  it("resolves older file metadata through its post", async () => {
    vi.mocked(fetchFileMetadata).mockResolvedValue({ post_id: "post1" });
    const { client, call } = fixture();
    const result = await call("get_file", { file_id: "f1" });
    expect(result.isError).toBe(true);
    expect(body(result)).toContain("MM_CHANNEL_ALLOWLIST");
    expect(client.getPost).toHaveBeenCalledWith("post1");
  });
  it("blocks attachments from another channel before posting", async () => {
    vi.mocked(fetchFileMetadata).mockResolvedValue({ channel_id: "blocked" });
    const { client, call } = fixture();
    const result = await call("post_message", {
      channel_id: "allowed",
      message: "attachment",
      file_ids: ["f1"],
    });
    expect(result.isError).toBe(true);
    expect(client.createPost).not.toHaveBeenCalled();
  });
  it("fails closed when a file's channel cannot be resolved", async () => {
    vi.mocked(fetchFileMetadata).mockResolvedValue({});
    const { call } = fixture();
    expect(body(await call("get_file", { file_id: "f1" }))).toContain("cannot resolve");
  });
  it.each([{ channelAllowlist: ["allowed"] }, { channelAllowlist: [], teamAllowlist: ["team1"] }])(
    "refuses unscoped DM creation before any write: %j",
    async (guardrails) => {
      const { client, call } = fixture(guardrails);
      expect((await call("send_dm", { user_ids: ["other"], message: "hello" })).isError).toBe(true);
      expect(client.createDirectChannel).not.toHaveBeenCalled();
      expect(client.createGroupChannel).not.toHaveBeenCalled();
      expect(client.createPost).not.toHaveBeenCalled();
    },
  );
  it("refuses creating a channel that cannot yet be in the channel allowlist", async () => {
    const { client, call } = fixture();
    const result = await call("create_channel", {
      team_id: "team1",
      name: "new",
      display_name: "New",
      type: "P",
    });
    expect(result.isError).toBe(true);
    expect(client.createChannel).not.toHaveBeenCalled();
  });
  it("filters team and channel listings by their applicable allowlists", async () => {
    const { call } = fixture({ teamAllowlist: ["team1"] });
    expect(JSON.parse(body(await call("list_teams")))).toEqual([{ id: "team1" }]);
    expect(JSON.parse(body(await call("list_channels", { team_id: "team1" })))).toEqual([
      { id: "allowed", team_id: "team1" },
    ]);
  });
  it("excludes other teams and teamless DMs under a team allowlist", async () => {
    const { call } = fixture({ channelAllowlist: [], teamAllowlist: ["team1"] });
    const result = JSON.parse(body(await call("list_channels", { team_id: "team1" })));
    expect(result.map((channel) => channel.id)).toEqual(["allowed", "blocked"]);
  });
  it("filters search content, order, match snippets, and cursor IDs together", async () => {
    const { call } = fixture();
    const result = await call("search_posts", { team_id: "team1", terms: "term" });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(body(result))).toEqual({
      order: ["p1"],
      posts: { p1: { id: "p1", channel_id: "allowed", message: "visible" } },
      matches: { p1: ["visible"] },
      next_post_id: "",
      prev_post_id: "p1",
    });
    expect(body(result)).not.toContain("hidden");
  });
  it.each(["get_post", "get_thread", "get_channel_posts", "search_posts"])(
    "omits cross-channel permalink preview content from %s",
    async (name) => {
      const { client, call } = fixture();
      const post = {
        id: "p1",
        channel_id: "allowed",
        message: "link to another conversation",
        metadata: {
          embeds: [
            { type: "image", url: "https://mm.test/image.png" },
            {
              type: "permalink",
              data: {
                channel_id: "blocked",
                post: { message: "private linked message" },
              },
            },
          ],
        },
      };
      client.getPost.mockResolvedValue(post);
      const list = { posts: { p1: post }, order: ["p1"], next_post_id: "next-page" };
      client.getPaginatedPostThread.mockResolvedValue(list);
      Object.assign(client, { getPosts: vi.fn(async () => list) });
      client.searchPosts.mockResolvedValue(list);
      const args =
        name === "get_post" || name === "get_thread"
          ? { post_id: "p1" }
          : name === "get_channel_posts"
            ? { channel_id: "allowed" }
            : { team_id: "team1", terms: "link" };
      const result = await call(name, args);
      expect(result.isError).toBeUndefined();
      expect(body(result)).not.toContain("private linked message");
      expect(body(result)).toContain("image.png");
      expect(body(result)).toContain(post.message);
      if (name !== "get_post") {
        expect(JSON.parse(body(result)).next_post_id).toBe("next-page");
      }
    },
  );
  it("preserves permalink previews when no allowlists are configured", async () => {
    const { client, call } = fixture({ channelAllowlist: [] });
    const post = {
      id: "p1",
      channel_id: "allowed",
      metadata: {
        embeds: [{ type: "permalink", data: { post: { message: "linked message" } } }],
      },
    };
    client.getPost.mockResolvedValue(post);
    expect(body(await call("get_post", { post_id: "p1" }))).toContain("linked message");
  });
});
