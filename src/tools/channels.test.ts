import { describe, it, expect, vi } from "vitest";
import mattermost, { type Client4 } from "@mattermost/client";
import type { Config, GuardrailConfig } from "../config.js";
import type { MattermostSession } from "../mattermost/types.js";
import { dispatchToolCall } from "./registry.js";
import { channelTools } from "./channels.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

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
): Promise<{ text: string; isError: boolean }> {
  const res = await dispatchToolCall(
    channelTools,
    { session: fakeSession(guardrails, client) },
    name,
    args,
  );
  return { text: (res.content[0] as { text: string }).text, isError: res.isError === true };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("list_channels", () => {
  it("blocks a team not in the team allowlist", async () => {
    const { text, isError } = await call(
      "list_channels",
      { team_id: "t9" },
      { teamAllowlist: ["t1"] },
      { getMyChannels: async () => [] as never },
    );
    expect(isError).toBe(true);
    expect(text).toMatch(/MM_TEAM_ALLOWLIST/);
  });

  it("allows a team that is in the allowlist", async () => {
    const channels = [{ id: "ch1", name: "general", team_id: "t1" }];
    const { text, isError } = await call(
      "list_channels",
      { team_id: "t1" },
      { teamAllowlist: ["t1"] },
      { getMyChannels: async () => channels as never },
    );
    expect(isError).toBe(false);
    const parsed = JSON.parse(text);
    expect(parsed[0].id).toBe("ch1");
  });
});

describe("create_channel", () => {
  it("rejects an invalid channel type with isError and /invalid arguments/", async () => {
    const { text, isError } = await call("create_channel", {
      name: "my-chan",
      display_name: "My Chan",
      type: "X",
      team_id: "tm1",
    });
    expect(isError).toBe(true);
    expect(text).toMatch(/invalid arguments/);
  });
});

describe("archive_channel", () => {
  it("is blocked without MM_ALLOW_DESTRUCTIVE", async () => {
    const { text, isError } = await call(
      "archive_channel",
      { channel_id: "ch1", confirm: true },
      { allowDestructive: false },
    );
    expect(isError).toBe(true);
    expect(text).toMatch(/MM_ALLOW_DESTRUCTIVE/);
  });

  it("is blocked when flag is set but confirm is absent", async () => {
    const { text, isError } = await call(
      "archive_channel",
      { channel_id: "ch1" },
      { allowDestructive: true },
    );
    expect(isError).toBe(true);
    expect(text).toMatch(/confirm:true/);
  });

  it("succeeds when both MM_ALLOW_DESTRUCTIVE and confirm:true are set", async () => {
    const { text, isError } = await call(
      "archive_channel",
      { channel_id: "ch1", confirm: true },
      { allowDestructive: true },
      { deleteChannel: async () => ({ status: "OK" }) as never },
    );
    expect(isError).toBe(false);
    expect(text).toContain("OK");
  });
});

describe("remove_member", () => {
  it("is blocked under read-only mode", async () => {
    const { text, isError } = await call(
      "remove_member",
      { channel_id: "ch1", user_id: "u2", confirm: true },
      { readOnly: true },
    );
    expect(isError).toBe(true);
    expect(text).toMatch(/read-only/);
  });
});

describe("get_unreads", () => {
  it("returns server unread counts instead of the membership's already-read counts", async () => {
    const rawMemberships = [
      { channel_id: "ch1", msg_count: 96, mention_count: 2, roles: "channel_user" },
      { channel_id: "ch2", msg_count: 100, mention_count: 0, roles: "channel_user" },
    ];
    const client = new mattermost.Client4();
    client.setUrl("http://mm.test");
    vi.spyOn(client, "getMyChannelMembers").mockResolvedValue(rawMemberships as never);
    const doFetch = vi
      .spyOn(client, "doFetch")
      .mockResolvedValueOnce({ channel_id: "ch1", team_id: "tm1", msg_count: 4, mention_count: 2 })
      .mockResolvedValueOnce({ channel_id: "ch2", team_id: "tm1", msg_count: 0, mention_count: 0 });

    const { text, isError } = await call("get_unreads", { team_id: "tm1" }, {}, client);

    expect(isError).toBe(false);
    const parsed = JSON.parse(text);
    expect(parsed).toEqual([
      { channel_id: "ch1", msg_count: 4, mention_count: 2 },
      { channel_id: "ch2", msg_count: 0, mention_count: 0 },
    ]);
    expect(doFetch).toHaveBeenNthCalledWith(
      1,
      "http://mm.test/api/v4/users/me/channels/ch1/unread",
      {
        method: "get",
      },
    );
    expect(doFetch).toHaveBeenNthCalledWith(
      2,
      "http://mm.test/api/v4/users/me/channels/ch2/unread",
      {
        method: "get",
      },
    );
  });

  it("does not fetch unread counts for channels outside the channel allowlist", async () => {
    const client = new mattermost.Client4();
    client.setUrl("http://mm.test");
    vi.spyOn(client, "getMyChannelMembers").mockResolvedValue([
      { channel_id: "ch1", msg_count: 96 },
      { channel_id: "ch2", msg_count: 100 },
    ] as never);
    const doFetch = vi
      .spyOn(client, "doFetch")
      .mockResolvedValue({ channel_id: "ch1", msg_count: 4, mention_count: 2 });

    const { text, isError } = await call(
      "get_unreads",
      { team_id: "tm1" },
      { channelAllowlist: ["ch1"] },
      client,
    );

    expect(isError).toBe(false);
    expect(JSON.parse(text)).toEqual([{ channel_id: "ch1", msg_count: 4, mention_count: 2 }]);
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(doFetch).toHaveBeenCalledWith("http://mm.test/api/v4/users/me/channels/ch1/unread", {
      method: "get",
    });
  });

  it("returns an empty list without unread requests when there are no memberships", async () => {
    const doFetch = vi.fn();
    const { text, isError } = await call(
      "get_unreads",
      { team_id: "tm1" },
      {},
      { getMyChannelMembers: async () => [], doFetch },
    );

    expect(isError).toBe(false);
    expect(JSON.parse(text)).toEqual([]);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("surfaces a failed unread request instead of reporting a misleading count", async () => {
    const client = new mattermost.Client4();
    client.setUrl("http://mm.test");
    vi.spyOn(client, "getMyChannelMembers").mockResolvedValue([
      { channel_id: "ch1", msg_count: 96 },
    ] as never);
    vi.spyOn(client, "doFetch").mockRejectedValue(new Error("unread endpoint failed"));

    const { text, isError } = await call("get_unreads", { team_id: "tm1" }, {}, client);

    expect(isError).toBe(true);
    expect(text).toBe("unread endpoint failed");
  });
});
