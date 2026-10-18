import { describe, expect, it } from "vitest";
import { ME, PEER, OK, useMattermost } from "./mattermost-http-fixture.js";

describe("channels, membership, and read state through the HTTP API", () => {
  const fixture = useMattermost({ guardrails: { allowDestructive: true } });

  it("discovers joined teams and channels, including existing personal conversations", async () => {
    const mm = fixture();
    const team = { id: "project-team", name: "project", display_name: "Project" };
    const channel = { id: "project-channel", team_id: team.id, type: "P", name: "planning" };
    const channels = [
      channel,
      { id: "existing-dm", team_id: "", type: "D" },
      { id: "existing-group", team_id: "", type: "G" },
    ];
    mm.expect("GET", "/users/me/teams", { reply: [team] });
    expect(await mm.call("list_teams")).toEqual([team]);
    mm.expect("GET", `/users/me/teams/${team.id}/channels`, {
      query: { include_deleted: false },
      reply: channels,
    });
    expect(await mm.call("list_channels", { team_id: team.id })).toEqual(channels);
    mm.expect("GET", `/channels/${channel.id}`, { reply: channel });
    expect(await mm.call("get_channel", { channel_id: channel.id })).toEqual(channel);
    mm.expect("GET", "/users/me/teams/empty-team/channels", {
      query: { include_deleted: false },
      reply: [],
    });
    expect(await mm.call("list_channels", { team_id: "empty-team" })).toEqual([]);
  });

  it("manages a private channel and joins/leaves a separate public channel", async () => {
    const mm = fixture();
    const args = { name: "planning", display_name: "Planning", type: "P", team_id: "project-team" };
    const channel = { ...args, id: "new-channel" };
    mm.expect("POST", "/channels", { body: args, reply: channel });
    const created = await mm.call<typeof channel>("create_channel", args);
    expect(created).toEqual(channel);
    // Creation already makes the owner a member; retain that membership to archive.
    const me = { channel_id: created.id, user_id: ME.id, roles: "channel_user channel_admin" };
    const peer = { channel_id: created.id, user_id: PEER.id, roles: "channel_user" };
    mm.expect("POST", `/channels/${created.id}/members`, {
      body: { channel_id: created.id, user_id: PEER.id, post_root_id: "" },
      reply: peer,
    });
    expect(await mm.call("add_member", { channel_id: created.id, user_id: PEER.id })).toEqual(peer);
    mm.expect("GET", `/channels/${created.id}/members`, {
      query: { page: 0, per_page: 60 },
      reply: [me, peer],
    });
    expect(await mm.call("list_channel_members", { channel_id: created.id })).toEqual([me, peer]);
    mm.expect("DELETE", `/channels/${created.id}/members/${PEER.id}`);
    expect(
      await mm.call("remove_member", {
        channel_id: created.id,
        user_id: PEER.id,
        confirm: true,
      }),
    ).toEqual(OK);
    const publicMember = { channel_id: "public-channel", user_id: ME.id, roles: "channel_user" };
    mm.expect("POST", "/channels/public-channel/members", {
      body: { channel_id: publicMember.channel_id, user_id: ME.id, post_root_id: "" },
      reply: publicMember,
    });
    expect(await mm.call("join_channel", { channel_id: publicMember.channel_id })).toEqual(
      publicMember,
    );
    mm.expect("DELETE", `/channels/public-channel/members/${ME.id}`);
    expect(await mm.call("leave_channel", { channel_id: publicMember.channel_id })).toEqual(OK);
    mm.expect("DELETE", `/channels/${created.id}`);
    expect(await mm.call("archive_channel", { channel_id: created.id, confirm: true })).toEqual(OK);
  });

  it("preserves explicit member pagination and an empty last page", async () => {
    const mm = fixture();
    mm.expect("GET", "/channels/project-channel/members", {
      query: { page: 2, per_page: 25 },
      reply: [],
    });
    expect(
      await mm.call("list_channel_members", {
        channel_id: "project-channel",
        page: 2,
        per_page: 25,
      }),
    ).toEqual([]);
  });

  it("uses actual unread counts, marks the owner's channel read, and handles no memberships", async () => {
    const mm = fixture();
    const memberships = [
      { channel_id: "project-channel", user_id: ME.id, msg_count: 150, mention_count: 2 },
      { channel_id: "other-channel", user_id: ME.id, msg_count: 500, mention_count: 0 },
    ];
    const before = [
      { channel_id: "project-channel", msg_count: 3, mention_count: 2 },
      { channel_id: "other-channel", msg_count: 0, mention_count: 0 },
    ];
    mm.expect("GET", "/users/me/teams/project-team/channels/members", { reply: memberships });
    for (const unread of before) {
      mm.expect("GET", `/users/me/channels/${unread.channel_id}/unread`, {
        reply: { ...unread, team_id: "project-team" },
      });
    }
    expect(await mm.call("get_unreads", { team_id: "project-team" })).toEqual(before);
    const viewed = { status: "OK", last_viewed_at_times: { "project-channel": 2000 } };
    mm.expect("POST", "/channels/members/me/view", {
      body: { channel_id: "project-channel", collapsed_threads_supported: true },
      reply: viewed,
    });
    expect(await mm.call("mark_channel_read", { channel_id: "project-channel" })).toEqual(viewed);
    mm.expect("GET", "/users/me/teams/project-team/channels/members", { reply: [memberships[0]] });
    const read = { channel_id: "project-channel", msg_count: 0, mention_count: 0 };
    mm.expect("GET", "/users/me/channels/project-channel/unread", { reply: read });
    expect(await mm.call("get_unreads", { team_id: "project-team" })).toEqual([read]);
    mm.expect("GET", "/users/me/teams/empty-team/channels/members", { reply: [] });
    expect(await mm.call("get_unreads", { team_id: "empty-team" })).toEqual([]);
  });

  it("filters joined-team/channel results to configured resources", async () => {
    const mm = fixture();
    mm.guardrails.teamAllowlist = ["project-team"];
    mm.guardrails.channelAllowlist = ["project-channel"];
    const team = { id: "project-team", name: "project" };
    mm.expect("GET", "/users/me/teams", { reply: [team, { id: "hidden-team", name: "hidden" }] });
    expect(await mm.call("list_teams")).toEqual([team]);
    const allowed = { id: "project-channel", team_id: team.id, type: "O" };
    mm.expect("GET", "/users/me/teams/project-team/channels", {
      query: { include_deleted: false },
      reply: [
        allowed,
        { id: "hidden-channel", team_id: team.id, type: "P" },
        { id: "dm", team_id: "", type: "D" },
      ],
    });
    expect(await mm.call("list_channels", { team_id: team.id })).toEqual([allowed]);
  });

  it("does not query unread counts for a channel outside the allowlist", async () => {
    const mm = fixture();
    mm.guardrails.channelAllowlist = ["project-channel"];
    mm.expect("GET", "/users/me/teams/project-team/channels/members", {
      reply: [{ channel_id: "project-channel" }, { channel_id: "hidden-channel" }],
    });
    const unread = { channel_id: "project-channel", msg_count: 4, mention_count: 1 };
    mm.expect("GET", "/users/me/channels/project-channel/unread", { reply: unread });
    expect(await mm.call("get_unreads", { team_id: "project-team" })).toEqual([unread]);
  });

  it("surfaces a private-channel membership refusal without retrying the write", async () => {
    const mm = fixture();
    mm.expect("POST", "/channels/private-channel/members", {
      body: { channel_id: "private-channel", user_id: ME.id, post_root_id: "" },
      status: 403,
      reply: {
        status_code: 403,
        id: "api.channel.add_member.permissions",
        message: "You do not have permission to join this channel.",
      },
    });
    expect(await mm.error("join_channel", { channel_id: "private-channel" })).toContain(
      "You do not have permission to join this channel.",
    );
  });
});
