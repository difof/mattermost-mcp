import { describe, it, expect } from "vitest";
import { dispatchToolCall } from "./registry.js";
import { userTools } from "./users.js";
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
  return { client: client, config, userId: "me1", call: (fn) => fn(client) };
}
async function call(name, args, guardrails = {}, client = {}) {
  const res = await dispatchToolCall(
    userTools,
    { session: fakeSession(guardrails, client) },
    name,
    args,
  );
  return { text: res.content[0].text, isError: res.isError === true };
}
describe("get_user", () => {
  it.each([{}, { user_id: "u1", username: "alice" }])(
    "requires exactly one of user_id and username: %j",
    async (args) => {
      const { text, isError } = await call("get_user", args);
      expect(isError).toBe(true);
      expect(text).toMatch(/invalid arguments.*exactly one/);
    },
  );
});
describe("set_status", () => {
  it("rejects an invalid status value", async () => {
    const { text, isError } = await call("set_status", { status: "busy" });
    expect(isError).toBe(true);
    expect(text).toMatch(/invalid arguments/);
  });
  it("is blocked under MM_READ_ONLY", async () => {
    const { text, isError } = await call("set_status", { status: "online" }, { readOnly: true });
    expect(isError).toBe(true);
    expect(text).toMatch(/read-only/);
  });
});
