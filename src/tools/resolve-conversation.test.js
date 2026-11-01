import { expect, it, vi } from "vitest";
import { resolveConversationTool as tool } from "./resolve-conversation.js";

it("does not choose between duplicate channel names or open a DM to resolve a username", async () => {
  const lookup = vi.fn(() => ({
    conversations: [
      { id: "a", teamId: "one" },
      { id: "b", teamId: "two" },
    ],
    nextCursor: null,
  }));
  const session = {
    cache: { refreshDirectory: vi.fn(), directory: { list: lookup } },
    call: (fn) => fn({ getUserByUsername: () => ({ id: "u".repeat(26), username: "fixture" }) }),
  };
  expect((await tool.handler({ channel_name: "alerts" }, { session })).status).toBe("ambiguous");
  expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ exact_name: "alerts" }));
  lookup.mockReturnValueOnce({ conversations: [], nextCursor: null });
  expect(await tool.handler({ username: "fixture" }, { session })).toEqual({
    status: "not_found",
    userId: "u".repeat(26),
  });
  expect(lookup).toHaveBeenLastCalledWith(
    expect.objectContaining({ channel_type: "D", peer_user_id: "u".repeat(26) }),
  );
});
