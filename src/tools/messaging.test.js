import { describe, it, expect, vi } from "vitest";
import { dispatchToolCall } from "./registry.js";
import { messagingTools } from "./messaging.js";
// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function fakeSession(guardrails = {}, client = {}) {
  const config = {
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
    client: client,
    config,
    userId: "me1",
    call: (fn) => fn(client),
  };
}
async function call(name, args, guardrails = {}, client = {}) {
  const res = await dispatchToolCall(
    messagingTools,
    { session: fakeSession(guardrails, client) },
    name,
    args,
  );
  return { text: res.content[0].text, isError: res.isError === true };
}
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("messaging tools", () => {
  // --- post_message ----------------------------------------------------------
  it("post_message: blocked by channel allowlist", async () => {
    const { text, isError } = await call(
      "post_message",
      { channel_id: "c9", message: "hello" },
      { channelAllowlist: ["c1"] },
      { createPost: async () => ({ id: "p1" }) },
    );
    expect(isError).toBe(true);
    expect(text).toMatch(/MM_CHANNEL_ALLOWLIST/);
  });
  it("post_message: an empty optional root_id remains a top-level post under allowlists", async () => {
    const createPost = vi.fn(async () => ({ id: "p1", channel_id: "c1" }));
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
      { createPost: async () => ({ id: "p1" }) },
    );
    expect(isError).toBe(true);
    expect(text).toMatch(/exceeds/);
  });
  // --- get_channel_posts ----------------------------------------------------
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
  // --- send_dm ---------------------------------------------------------------
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
    const createGroupChannel = vi.fn(async () => ({ id: "group8" }));
    const createPost = vi.fn(async () => ({ id: "p8" }));
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
      { deletePost: async () => ({}) },
    );
    expect(isError).toBe(true);
    expect(text).toMatch(/MM_ALLOW_DESTRUCTIVE/);
  });
  it("delete_post: blocked with flag but without confirm:true", async () => {
    const { text, isError } = await call(
      "delete_post",
      { post_id: "p1" },
      { allowDestructive: true },
      { deletePost: async () => ({}) },
    );
    expect(isError).toBe(true);
    expect(text).toMatch(/confirm:true/);
  });
  it("delete_post: allowed with confirm:true and allowDestructive:true", async () => {
    const { text, isError } = await call(
      "delete_post",
      { post_id: "p1", confirm: true },
      { allowDestructive: true },
      { deletePost: async () => ({ status: "OK" }) },
    );
    expect(isError).toBe(false);
    expect(text).toContain("OK");
  });
});
