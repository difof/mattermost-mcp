import { expect, it, vi } from "vitest";
import { typingTool } from "./typing.js";
import { dispatchToolCall } from "./registry.js";
const config = {
  guardrails: {
    readOnly: false,
    allowDestructive: false,
    teamAllowlist: [],
    channelAllowlist: [],
    maxMessageLen: 100,
  },
};
it("uses only selected identity, checks membership and does not send after a guard failure", async () => {
  const calls = [],
    client = {
      getChannelMember: vi.fn(async () => ({})),
      getUserRoute: (id) => "/users/" + id,
      doFetch: vi.fn(async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body) });
        return {};
      }),
    };
  const session = {
    config,
    userId: "a".repeat(26),
    accountId: "assistant",
    call: (fn) => fn(client),
  };
  const channel = "b".repeat(26),
    ctx = { session };
  expect(
    (await dispatchToolCall([typingTool], ctx, "publish_typing", { channel_id: channel })).isError,
  ).toBeUndefined();
  expect(client.getChannelMember).toHaveBeenCalledWith(channel, session.userId);
  expect(calls).toEqual([
    { url: "/users/" + session.userId + "/typing", body: { channel_id: channel } },
  ]);
  client.getChannelMember.mockRejectedValueOnce(new Error("denied"));
  expect(
    (await dispatchToolCall([typingTool], ctx, "publish_typing", { channel_id: channel })).isError,
  ).toBe(true);
  expect(calls).toHaveLength(1);
});
