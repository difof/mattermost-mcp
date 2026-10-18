import { describe, it, expect } from "vitest";
import type { Client4 } from "@mattermost/client";
import type { Config, GuardrailConfig } from "../config.js";
import type { MattermostSession } from "../mattermost/types.js";
import { dispatchToolCall } from "./registry.js";
import { userTools } from "./users.js";

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
  return { client: client as Client4, config, userId: "me1", call: (fn) => fn(client as Client4) };
}

async function call(
  name: string,
  args: unknown,
  guardrails: Partial<GuardrailConfig> = {},
  client: Partial<Client4> = {},
) {
  const res = await dispatchToolCall(
    userTools,
    { session: fakeSession(guardrails, client) },
    name,
    args,
  );
  return { text: (res.content[0] as { text: string }).text, isError: res.isError === true };
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
