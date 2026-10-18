import { describe, it, expect } from "vitest";
import { z } from "zod";
import mattermost from "@mattermost/client";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { buildToolList, dispatchToolCall } from "./registry.js";
import { getMe } from "./users.js";
// --- fixtures ----------------------------------------------------------------
function fakeSession(
  guardrails = {},
  client = { getMe: async () => ({ id: "u1", username: "alice" }) },
) {
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
    userId: "u1",
    call: (fn) => fn(client),
  };
}
const writeTool = {
  name: "w_post",
  title: "Write",
  description: "",
  inputSchema: z.object({}),
  write: true,
  handler: async () => "ok",
};
const destructiveTool = {
  name: "d_del",
  title: "Delete",
  description: "",
  inputSchema: z.object({ confirm: z.boolean().optional() }),
  destructive: true,
  handler: async () => "deleted",
};
const reqTool = {
  name: "needs_id",
  title: "Needs id",
  description: "",
  inputSchema: z.object({ id: z.string() }),
  handler: async (a) => a.id,
};
const chanTool = {
  name: "chan",
  title: "Chan",
  description: "",
  inputSchema: z.object({ channel_id: z.string() }),
  write: true,
  resources: (a) => ({ channelId: a.channel_id }),
  handler: async () => "posted",
};
const msgTool = {
  name: "msg",
  title: "Msg",
  description: "",
  inputSchema: z.object({ message: z.string() }),
  write: true,
  messageText: (a) => a.message,
  handler: async () => "sent",
};
const boomTool = {
  name: "boom",
  title: "Boom",
  description: "",
  inputSchema: z.object({}),
  handler: async () => {
    throw new mattermost.ClientError("http://mm.test", { message: "Forbidden", status_code: 403 });
  },
};
const ALL = [getMe, writeTool, destructiveTool, reqTool, chanTool, msgTool, boomTool];
async function call(name, args, guardrails = {}) {
  const res = await dispatchToolCall(ALL, { session: fakeSession(guardrails) }, name, args);
  return { text: res.content[0].text, isError: res.isError === true };
}
// --- tests -------------------------------------------------------------------
describe("buildToolList (zod → MCP)", () => {
  const byName = Object.fromEntries(buildToolList(ALL).tools.map((t) => [t.name, t]));
  it("exposes get_me with an object input schema and no $schema marker", () => {
    const t = byName["get_me"];
    expect(t.inputSchema.type).toBe("object");
    expect(t).not.toHaveProperty("inputSchema.$schema");
    expect(JSON.stringify(t.inputSchema)).not.toContain("$schema");
  });
  it("marks a read tool readOnlyHint=true, non-destructive", () => {
    expect(byName["get_me"].annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
  });
  it("marks a write tool readOnlyHint=false", () => {
    expect(byName["w_post"].annotations.readOnlyHint).toBe(false);
  });
  it("marks a destructive tool destructiveHint=true", () => {
    expect(byName["d_del"].annotations.destructiveHint).toBe(true);
  });
  it("carries required fields from the zod schema", () => {
    expect(byName["needs_id"].inputSchema.required).toEqual(["id"]);
  });
});
describe("dispatchToolCall", () => {
  it("runs a read tool and returns its JSON result", async () => {
    const { text, isError } = await call("get_me", {});
    expect(isError).toBe(false);
    expect(text).toContain("alice");
  });
  it("reports an unknown tool as a protocol InvalidParams error", async () => {
    await expect(call("nope", {})).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
      message: expect.stringContaining("unknown tool: nope"),
    });
  });
  it("rejects invalid arguments", async () => {
    const { text, isError } = await call("needs_id", {});
    expect(isError).toBe(true);
    expect(text).toMatch(/invalid arguments[\s\S]*id/);
  });
  it("blocks a write tool under MM_READ_ONLY", async () => {
    const { text, isError } = await call("w_post", {}, { readOnly: true });
    expect(isError).toBe(true);
    expect(text).toMatch(/read-only/);
  });
  it("gates a destructive tool without the env flag", async () => {
    const { text, isError } = await call("d_del", { confirm: true });
    expect(isError).toBe(true);
    expect(text).toMatch(/MM_ALLOW_DESTRUCTIVE/);
  });
  it("gates a destructive tool without confirm:true", async () => {
    const { isError, text } = await call("d_del", {}, { allowDestructive: true });
    expect(isError).toBe(true);
    expect(text).toMatch(/confirm:true/);
  });
  it("allows a fully-authorized destructive call", async () => {
    const { text, isError } = await call("d_del", { confirm: true }, { allowDestructive: true });
    expect(isError).toBe(false);
    expect(text).toBe("deleted");
  });
  it("enforces the channel allowlist", async () => {
    const blocked = await call("chan", { channel_id: "c9" }, { channelAllowlist: ["c1"] });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toMatch(/MM_CHANNEL_ALLOWLIST/);
    const ok = await call("chan", { channel_id: "c1" }, { channelAllowlist: ["c1"] });
    expect(ok.isError).toBe(false);
  });
  it("enforces the message length limit", async () => {
    const over = await call("msg", { message: "abcdef" }, { maxMessageLen: 5 });
    expect(over.isError).toBe(true);
    expect(over.text).toMatch(/exceeds/);
    const ok = await call("msg", { message: "abc" }, { maxMessageLen: 5 });
    expect(ok.isError).toBe(false);
  });
  it("surfaces a Mattermost API error verbatim", async () => {
    const { text, isError } = await call("boom", {});
    expect(isError).toBe(true);
    expect(text).toBe("Mattermost API error 403: Forbidden");
  });
});
