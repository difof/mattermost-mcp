import { describe, it, expect, vi } from "vitest";
import type { Client4 } from "@mattermost/client";
import type { Config, GuardrailConfig } from "../config.js";
import type { MattermostSession } from "../mattermost/types.js";
import { dispatchToolCall } from "./registry.js";
import { messagingTools } from "./messaging.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fakeSession(
  guardrails: Partial<GuardrailConfig> = {},
  client: Partial<Client4> = {},
): MattermostSession {
  const config: Config = {
    url: "http://mm.test",
    auth: { mode: "pat", token: "t" },
    guardrails: {
      readOnly: false,
      allowDestructive: false,
      teamAllowlist: [],
      channelAllowlist: [],
      maxMessageLen: 16383,
      ...guardrails,
    },
  };
  return {
    client: client as Client4,
    config,
    userId: "me1",
    call: (fn) => fn(client as Client4),
  };
}

async function call(
  name: string,
  args: unknown,
  guardrails: Partial<GuardrailConfig> = {},
  client: Partial<Client4> = {},
): Promise<{ text: string; isError: boolean }> {
  const res = await dispatchToolCall(
    messagingTools,
    { session: fakeSession(guardrails, client) },
    name,
    args,
  );
  return { text: (res.content[0] as { text: string }).text, isError: res.isError === true };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("messaging tools", () => {
  // --- post_message ----------------------------------------------------------

  it("post_message: happy path returns the created post", async () => {
    const { text, isError } = await call(
      "post_message",
      { channel_id: "c1", message: "hello" },
      {},
      { createPost: async () => ({ id: "p1", message: "hello" }) as never },
    );
    expect(isError).toBe(false);
    expect(text).toContain("p1");
  });

  it("post_message: blocked by channel allowlist", async () => {
    const { text, isError } = await call(
      "post_message",
      { channel_id: "c9", message: "hello" },
      { channelAllowlist: ["c1"] },
      { createPost: async () => ({ id: "p1" }) as never },
    );
    expect(isError).toBe(true);
    expect(text).toMatch(/MM_CHANNEL_ALLOWLIST/);
  });

  it("post_message: an empty optional root_id remains a top-level post under allowlists", async () => {
    const createPost = vi.fn(async () => ({ id: "p1", channel_id: "c1" }) as never);
    const getPost = vi.fn();
    const { isError } = await call(
      "post_message",
      { channel_id: "c1", message: "hello", root_id: "" },
      { channelAllowlist: ["c1"] },
      { createPost, getPost },
    );

    expect(isError).toBe(false);
    expect(createPost).toHaveBeenCalledWith({ channel_id: "c1", message: "hello", root_id: "" });
    expect(getPost).not.toHaveBeenCalled();
  });

  it("post_message: blocked when message exceeds maxMessageLen", async () => {
    const { text, isError } = await call(
      "post_message",
      { channel_id: "c1", message: "abcdef" },
      { maxMessageLen: 5 },
      { createPost: async () => ({ id: "p1" }) as never },
    );
    expect(isError).toBe(true);
    expect(text).toMatch(/exceeds/);
  });

  // --- get_channel_posts ----------------------------------------------------

  it("get_channel_posts: omitted pagination uses defaults", async () => {
    const getPosts = vi.fn(async () => ({ order: [], posts: {} }) as never);
    const { isError } = await call("get_channel_posts", { channel_id: "c1" }, {}, { getPosts });

    expect(isError).toBe(false);
    expect(getPosts).toHaveBeenCalledWith("c1", 0, 60);
  });

  it("get_channel_posts: since alone does not gain conflicting pagination defaults", async () => {
    const getPostsSince = vi.fn(async () => ({ order: [], posts: {} }) as never);
    const getPosts = vi.fn();
    const { isError } = await call(
      "get_channel_posts",
      { channel_id: "c1", since: 1720000000000 },
      {},
      { getPostsSince, getPosts },
    );

    expect(isError).toBe(false);
    expect(getPostsSince).toHaveBeenCalledWith("c1", 1720000000000);
    expect(getPosts).not.toHaveBeenCalled();
  });

  it.each(["before", "after"] as const)(
    "get_channel_posts: %s preserves explicit pagination",
    async (cursor) => {
      const getPostsBefore = vi.fn(async () => ({ order: [], posts: {} }) as never);
      const getPostsAfter = vi.fn(async () => ({ order: [], posts: {} }) as never);
      const { isError } = await call(
        "get_channel_posts",
        { channel_id: "c1", [cursor]: "p1", page: 2, per_page: 25 },
        {},
        { getPostsBefore, getPostsAfter },
      );

      expect(isError).toBe(false);
      expect(cursor === "before" ? getPostsBefore : getPostsAfter).toHaveBeenCalledWith(
        "c1",
        "p1",
        2,
        25,
      );
      expect(cursor === "before" ? getPostsAfter : getPostsBefore).not.toHaveBeenCalled();
    },
  );

  it.each([
    { since: 1720000000000, before: "p1" },
    { since: 1720000000000, after: "p1" },
    { since: 1720000000000, page: 0 },
    { since: 1720000000000, per_page: 60 },
    { before: "p1", after: "p2" },
  ])("get_channel_posts: rejects conflicting filters %j before an API call", async (filters) => {
    const client = {
      getPosts: vi.fn(),
      getPostsSince: vi.fn(),
      getPostsBefore: vi.fn(),
      getPostsAfter: vi.fn(),
    };
    const { text, isError } = await call(
      "get_channel_posts",
      { channel_id: "c1", ...filters },
      {},
      client,
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/invalid arguments.*(cannot be combined|mutually exclusive)/);
    for (const method of Object.values(client)) expect(method).not.toHaveBeenCalled();
  });

  // --- get_post --------------------------------------------------------------

  it("get_post: happy path returns the post", async () => {
    const { text, isError } = await call(
      "get_post",
      { post_id: "p42" },
      {},
      { getPost: async () => ({ id: "p42", message: "content" }) as never },
    );
    expect(isError).toBe(false);
    expect(text).toContain("p42");
  });

  // --- add_reaction ----------------------------------------------------------

  it("add_reaction: calls addReaction with session.userId (me1)", async () => {
    let capturedUserId: string | undefined;
    const { text, isError } = await call(
      "add_reaction",
      { post_id: "p1", emoji_name: "thumbsup" },
      {},
      {
        addReaction: async (userId: string, postId: string, emojiName: string) => {
          capturedUserId = userId;
          return { user_id: userId, post_id: postId, emoji_name: emojiName } as never;
        },
      },
    );
    expect(isError).toBe(false);
    expect(capturedUserId).toBe("me1");
    expect(text).toContain("me1");
  });

  // --- edit_post -------------------------------------------------------------

  it("edit_post: calls patchPost (not createPost)", async () => {
    let capturedPatch: unknown;
    const { text, isError } = await call(
      "edit_post",
      { post_id: "p1", message: "updated" },
      {},
      {
        patchPost: async (patch: unknown) => {
          capturedPatch = patch;
          return { id: "p1", message: "updated" } as never;
        },
      },
    );
    expect(isError).toBe(false);
    expect(capturedPatch).toMatchObject({ id: "p1", message: "updated" });
    expect(text).toContain("p1");
  });

  // --- send_dm ---------------------------------------------------------------

  it("send_dm: 1 other user → createDirectChannel with 2 members, then createPost", async () => {
    let capturedMembers: string[] | undefined;
    let capturedChannelId: string | undefined;

    const { text, isError } = await call(
      "send_dm",
      { user_ids: ["other1"], message: "hey" },
      {},
      {
        createDirectChannel: async (userIds: string[]) => {
          capturedMembers = userIds;
          return { id: "dm-channel" } as never;
        },
        createPost: async (post: { channel_id: string; message: string }) => {
          capturedChannelId = post.channel_id;
          return { id: "p1", channel_id: post.channel_id, message: post.message } as never;
        },
      },
    );

    expect(isError).toBe(false);
    expect(capturedMembers).toEqual(["me1", "other1"]);
    expect(capturedChannelId).toBe("dm-channel");
    expect(text).toContain("p1");
  });

  it("send_dm: 2 other users → createGroupChannel with 3 members", async () => {
    let capturedMembers: string[] | undefined;

    await call(
      "send_dm",
      { user_ids: ["u2", "u3"], message: "hey group" },
      {},
      {
        createGroupChannel: async (userIds: string[]) => {
          capturedMembers = userIds;
          return { id: "grp-channel" } as never;
        },
        createPost: async () => ({ id: "p2" }) as never,
      },
    );

    expect(capturedMembers).toEqual(["me1", "u2", "u3"]);
  });

  it.each([
    { user_ids: ["u2", "u2"], error: /unique participants/ },
    { user_ids: ["me1"], error: /not the authenticated user/ },
    { user_ids: ["u2", "me1"], error: /not the authenticated user/ },
    { user_ids: [""], error: /at least 1 character/ },
  ])("send_dm: rejects invalid participants $user_ids before creating a channel", async (input) => {
    const client = {
      createDirectChannel: vi.fn(),
      createGroupChannel: vi.fn(),
      createPost: vi.fn(),
    };
    const { text, isError } = await call(
      "send_dm",
      { user_ids: input.user_ids, message: "hello" },
      {},
      client,
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/invalid arguments/);
    expect(text).toMatch(input.error);
    for (const method of Object.values(client)) expect(method).not.toHaveBeenCalled();
  });

  it("send_dm: seven other users produce an eight-person group", async () => {
    const otherUsers = ["u2", "u3", "u4", "u5", "u6", "u7", "u8"];
    const createGroupChannel = vi.fn(async () => ({ id: "group8" }) as never);
    const createPost = vi.fn(async () => ({ id: "p8" }) as never);
    const { isError } = await call(
      "send_dm",
      { user_ids: otherUsers, message: "hello everyone" },
      {},
      { createGroupChannel, createPost },
    );

    expect(isError).toBe(false);
    expect(createGroupChannel).toHaveBeenCalledWith(["me1", ...otherUsers]);
    expect(createPost).toHaveBeenCalledWith({ channel_id: "group8", message: "hello everyone" });
  });

  // --- delete_post -----------------------------------------------------------

  it("delete_post: blocked without confirm AND without flag", async () => {
    const { text, isError } = await call(
      "delete_post",
      { post_id: "p1" },
      {},
      { deletePost: async () => ({}) as never },
    );
    expect(isError).toBe(true);
    expect(text).toMatch(/MM_ALLOW_DESTRUCTIVE/);
  });

  it("delete_post: blocked with flag but without confirm:true", async () => {
    const { text, isError } = await call(
      "delete_post",
      { post_id: "p1" },
      { allowDestructive: true },
      { deletePost: async () => ({}) as never },
    );
    expect(isError).toBe(true);
    expect(text).toMatch(/confirm:true/);
  });

  it("delete_post: allowed with confirm:true and allowDestructive:true", async () => {
    const { text, isError } = await call(
      "delete_post",
      { post_id: "p1", confirm: true },
      { allowDestructive: true },
      { deletePost: async () => ({ status: "OK" }) as never },
    );
    expect(isError).toBe(false);
    expect(text).toContain("OK");
  });
});
