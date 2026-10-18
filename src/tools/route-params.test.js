import { afterEach, describe, expect, it, vi } from "vitest";
import { buildClient } from "../mattermost/client.js";
import { allTools } from "./index.js";
import { dispatchToolCall } from "./registry.js";

function caller(guardrails = {}) {
  const client = buildClient("http://mattermost.invalid", 0);
  client.setToken("test-only-route-token");
  const session = {
    client,
    userId: "current-user",
    config: {
      guardrails: {
        readOnly: false,
        allowDestructive: true,
        teamAllowlist: [],
        channelAllowlist: [],
        maxMessageLen: 16383,
        ...guardrails,
      },
    },
    call: (fn) => fn(client),
  };
  return (name, args) => dispatchToolCall(allTools, { session }, name, args);
}

afterEach(() => vi.unstubAllGlobals());

describe("convenience tool URL boundaries", () => {
  it("rejects route-changing arguments before authenticated SDK calls or resource lookups", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const call = caller({ readOnly: true, channelAllowlist: ["allowed-channel"] });
    const attempts = [
      ["get_user", { user_id: "../posts/target/reveal" }],
      ["get_user", { username: "../../access_control_policies/policy/activate" }],
      ["get_user_status", { user_id: "me?override=1" }],
      ["get_channel", { channel_id: "..\\posts\\target" }],
      ["list_channels", { team_id: "%2e%2e%2fposts" }],
      ["get_unreads", { team_id: "team#suffix" }],
      ["get_post", { post_id: "." }],
      ["get_thread", { post_id: ".." }],
      ["get_file", { file_id: "..." }],
      ["get_file_metadata", { file_id: "file\u0000suffix" }],
      ["get_channel_posts", { channel_id: "allowed-channel", before: "post\nsuffix" }],
      ["get_channel_posts", { channel_id: "allowed-channel", after: "post\u007fsuffix" }],
      ["post_message", { channel_id: "allowed-channel", message: "x", root_id: "..%2fpost" }],
      ["post_message", { channel_id: "allowed-channel", message: "x", file_ids: ["file?x"] }],
      ["send_dm", { user_ids: ["../users/other"], message: "x" }],
      ["remove_member", { channel_id: "allowed-channel", user_id: "../../other", confirm: true }],
      ["remove_reaction", { post_id: "post", emoji_name: "thumbsup/other" }],
    ];
    for (const [name, args] of attempts) {
      const result = await call(name, args);
      expect(result.isError, `${name}: ${JSON.stringify(args)}`).toBe(true);
      expect(result.content[0].text).toContain("invalid arguments");
      expect(result.content[0].text).toContain("literal path segment");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves normal literal identifiers and dotted usernames through Client4", async () => {
    const fetch = vi.fn(async () => Response.json({ id: "short-id" }));
    vi.stubGlobal("fetch", fetch);
    const call = caller();
    for (const [name, args, path] of [
      ["get_user", { user_id: "me" }, "/users/me"],
      ["get_user", { username: "jane.doe-test" }, "/users/username/jane.doe-test"],
      ["get_channel", { channel_id: "short-id" }, "/channels/short-id"],
    ]) {
      expect((await call(name, args)).isError).toBeUndefined();
      const [url, options] = fetch.mock.lastCall;
      expect(new URL(url).pathname).toBe(`/api/v4${path}`);
      expect(options.headers.Authorization).toMatch(/^Bearer test-only-route-token$/i);
    }
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("rejects a misspelled optional reply argument instead of posting to the channel", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const result = await caller()("post_message", {
      channel_id: "channel",
      message: "Intended as a reply",
      rootId: "thread",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("rootId");
    expect(fetch).not.toHaveBeenCalled();
  });
});
