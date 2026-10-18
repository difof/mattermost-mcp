import { z } from "zod";
import { routeSegment } from "./route-params.js";
import { doClientFetch } from "../mattermost/client.js";
// ── 1. list_teams ────────────────────────────────────────────────────────────
const listTeams = {
  name: "list_teams",
  title: "List my teams",
  description:
    "Return all Mattermost teams the authenticated user belongs to (GET /users/me/teams).",
  inputSchema: z.object({}).strict(),
  resultScope: "teams",
  handler: (_args, { session }) => session.call((c) => c.getMyTeams()),
};
// ── 2. list_channels ─────────────────────────────────────────────────────────
const listChannels = {
  name: "list_channels",
  title: "List my channels",
  description:
    "Return all channels the authenticated user belongs to in a team (GET /users/me/teams/{tid}/channels).",
  inputSchema: z
    .object({
      team_id: routeSegment.describe("Team ID to list channels for."),
    })
    .strict(),
  resources: (args) => ({ teamId: args.team_id }),
  resultScope: "channels",
  handler: (args, { session }) => session.call((c) => c.getMyChannels(args.team_id)),
};
// ── 3. get_channel ───────────────────────────────────────────────────────────
const getChannel = {
  name: "get_channel",
  title: "Get channel",
  description: "Return a single channel by ID (GET /channels/{id}).",
  inputSchema: z
    .object({
      channel_id: routeSegment.describe("Channel ID to retrieve."),
    })
    .strict(),
  resources: (args) => ({ channelId: args.channel_id }),
  handler: (args, { resources }) => resources.channel(args.channel_id),
};
// ── 4. create_channel ────────────────────────────────────────────────────────
const createChannel = {
  name: "create_channel",
  title: "Create channel",
  description: "Create a new channel in a team (POST /channels).",
  inputSchema: z
    .object({
      name: z.string().describe("URL-safe handle for the channel (slug)."),
      display_name: z.string().describe("Human-readable channel name."),
      type: z.enum(["O", "P"]).describe("Channel type: O = public, P = private."),
      team_id: routeSegment.describe("Team ID in which to create the channel."),
    })
    .strict(),
  write: true,
  resources: (args) => ({ teamId: args.team_id, createsChannel: true }),
  handler: (args, { session }) =>
    session.call((c) =>
      c.createChannel({
        name: args.name,
        display_name: args.display_name,
        type: args.type,
        team_id: args.team_id,
      }),
    ),
};
// ── 5. join_channel ──────────────────────────────────────────────────────────
const joinChannel = {
  name: "join_channel",
  title: "Join channel",
  description: "Add the authenticated user to a channel (POST /channels/{id}/members).",
  inputSchema: z
    .object({
      channel_id: routeSegment.describe("Channel ID to join."),
    })
    .strict(),
  write: true,
  resources: (args) => ({ channelId: args.channel_id }),
  handler: (args, { session }) =>
    session.call((c) => c.addToChannel(session.userId, args.channel_id)),
};
// ── 6. leave_channel ─────────────────────────────────────────────────────────
const leaveChannel = {
  name: "leave_channel",
  title: "Leave channel",
  description:
    "Remove the authenticated user from a channel (DELETE /channels/{id}/members/{uid}).",
  inputSchema: z
    .object({
      channel_id: routeSegment.describe("Channel ID to leave."),
    })
    .strict(),
  write: true,
  resources: (args) => ({ channelId: args.channel_id }),
  handler: (args, { session }) =>
    session.call((c) => c.removeFromChannel(session.userId, args.channel_id)),
};
// ── 7. archive_channel ───────────────────────────────────────────────────────
const archiveChannel = {
  name: "archive_channel",
  title: "Archive channel",
  description: "Soft-delete (archive) a channel (DELETE /channels/{id}).",
  inputSchema: z
    .object({
      channel_id: routeSegment.describe("Channel ID to archive."),
      confirm: z
        .boolean()
        .optional()
        .describe("Must be true to authorize this destructive action."),
    })
    .strict(),
  destructive: true,
  resources: (args) => ({ channelId: args.channel_id }),
  handler: (args, { session }) => session.call((c) => c.deleteChannel(args.channel_id)),
};
// ── 8. list_channel_members ──────────────────────────────────────────────────
const listChannelMembers = {
  name: "list_channel_members",
  title: "List channel members",
  description: "Return a page of members for a channel (GET /channels/{id}/members).",
  inputSchema: z
    .object({
      channel_id: routeSegment.describe("Channel ID."),
      page: z.number().int().min(0).optional().default(0).describe("Zero-based page number."),
      per_page: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(60)
        .describe("Number of members per page."),
    })
    .strict(),
  resources: (args) => ({ channelId: args.channel_id }),
  handler: (args, { session }) =>
    session.call((c) => c.getChannelMembers(args.channel_id, args.page, args.per_page)),
};
// ── 9. add_member ────────────────────────────────────────────────────────────
const addMember = {
  name: "add_member",
  title: "Add member to channel",
  description: "Add a user to a channel (POST /channels/{id}/members).",
  inputSchema: z
    .object({
      channel_id: routeSegment.describe("Channel ID."),
      user_id: routeSegment.describe("ID of the user to add."),
    })
    .strict(),
  write: true,
  resources: (args) => ({ channelId: args.channel_id }),
  handler: (args, { session }) =>
    session.call((c) => c.addToChannel(args.user_id, args.channel_id)),
};
// ── 10. remove_member ────────────────────────────────────────────────────────
const removeMember = {
  name: "remove_member",
  title: "Remove member from channel",
  description: "Remove a user from a channel (DELETE /channels/{id}/members/{uid}).",
  inputSchema: z
    .object({
      channel_id: routeSegment.describe("Channel ID."),
      user_id: routeSegment.describe("ID of the user to remove."),
      confirm: z
        .boolean()
        .optional()
        .describe("Must be true to authorize this destructive action."),
    })
    .strict(),
  destructive: true,
  resources: (args) => ({ channelId: args.channel_id }),
  handler: (args, { session }) =>
    session.call((c) => c.removeFromChannel(args.user_id, args.channel_id)),
};
// ── 11. get_unreads ──────────────────────────────────────────────────────────
const getUnreads = {
  name: "get_unreads",
  title: "Get channel unreads",
  description:
    "Return unread counts per channel for the authenticated user in a team (GET /users/me/teams/{tid}/channels/members, then GET /users/me/channels/{id}/unread).",
  inputSchema: z
    .object({
      team_id: routeSegment.describe("Team ID to query."),
    })
    .strict(),
  resources: (args) => ({ teamId: args.team_id }),
  resultScope: "channelItems",
  handler: async (args, { session }) => {
    const memberships = await session.call((c) => c.getMyChannelMembers(args.team_id));
    const { channelAllowlist } = session.config.guardrails;
    const allowedMemberships = memberships.filter(
      (m) => channelAllowlist.length === 0 || channelAllowlist.includes(m.channel_id),
    );
    const unreads = [];
    for (const membership of allowedMemberships) {
      // Membership.msg_count counts posts already read. Ask the unread endpoint
      // for actual unread counts; Client4 11.6 has no dedicated method for it.
      // https://docs.mattermost.com/api/reference/get-channel-unread
      const unread = await session.call((c) =>
        doClientFetch(
          c,
          `${c.getUserRoute("me")}/channels/${encodeURIComponent(membership.channel_id)}/unread`,
          { method: "get" },
        ),
      );
      unreads.push({
        channel_id: unread.channel_id,
        msg_count: unread.msg_count,
        mention_count: unread.mention_count,
      });
    }
    return unreads;
  },
};
// ── 12. mark_channel_read ────────────────────────────────────────────────────
const markChannelRead = {
  name: "mark_channel_read",
  title: "Mark channel as read",
  description:
    "Mark a channel as fully read for the authenticated user (POST /channels/members/me/view).",
  inputSchema: z
    .object({
      channel_id: routeSegment.describe("Channel ID to mark as read."),
    })
    .strict(),
  write: true,
  resources: (args) => ({ channelId: args.channel_id }),
  handler: (args, { session }) => session.call((c) => c.viewMyChannel(args.channel_id)),
};
// ── Export ───────────────────────────────────────────────────────────────────
export const channelTools = [
  listTeams,
  listChannels,
  getChannel,
  createChannel,
  joinChannel,
  leaveChannel,
  archiveChannel,
  listChannelMembers,
  addMember,
  removeMember,
  getUnreads,
  markChannelRead,
];
