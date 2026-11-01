// Source-audited mapping between public MCP tools and registered Mattermost routes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { REPO_ROOT } from "../mattermost-source.mjs";
import { authenticationFamily } from "./server-routes.mjs";
import { sortedObject } from "./routes.mjs";

// Reviewed route mapping, not an inference from tool names. /users/me uses the
// canonical {user_id} operation and is not a separate route.
const TOOL_ROUTES = {
  get_me: ["GET /api/v4/users/{user_id}"],
  get_user: ["GET /api/v4/users/{user_id}", "GET /api/v4/users/username/{username}"],
  search_users: ["POST /api/v4/users/search"],
  get_user_status: ["GET /api/v4/users/{user_id}/status"],
  set_status: ["PUT /api/v4/users/{user_id}/status"],
  set_custom_status: ["PUT /api/v4/users/{user_id}/status/custom"],
  post_message: ["POST /api/v4/posts"],
  reply_thread: ["POST /api/v4/posts"],
  get_channel_posts: ["GET /api/v4/channels/{channel_id}/posts"],
  get_thread: ["GET /api/v4/posts/{post_id}/thread"],
  get_post: ["GET /api/v4/posts/{post_id}"],
  search_posts: ["POST /api/v4/teams/{team_id}/posts/search"],
  edit_post: ["PUT /api/v4/posts/{post_id}/patch"],
  delete_post: ["DELETE /api/v4/posts/{post_id}"],
  send_dm: ["POST /api/v4/channels/direct", "POST /api/v4/channels/group", "POST /api/v4/posts"],
  pin_post: ["POST /api/v4/posts/{post_id}/pin"],
  unpin_post: ["POST /api/v4/posts/{post_id}/unpin"],
  add_reaction: ["POST /api/v4/reactions"],
  remove_reaction: ["DELETE /api/v4/users/{user_id}/posts/{post_id}/reactions/{emoji_name}"],
  list_teams: ["GET /api/v4/users/{user_id}/teams"],
  list_channels: ["GET /api/v4/users/{user_id}/teams/{team_id}/channels"],
  get_channel: ["GET /api/v4/channels/{channel_id}"],
  create_channel: ["POST /api/v4/channels"],
  join_channel: ["POST /api/v4/channels/{channel_id}/members"],
  leave_channel: ["DELETE /api/v4/channels/{channel_id}/members/{user_id}"],
  archive_channel: ["DELETE /api/v4/channels/{channel_id}"],
  list_channel_members: ["GET /api/v4/channels/{channel_id}/members"],
  add_member: ["POST /api/v4/channels/{channel_id}/members"],
  remove_member: ["DELETE /api/v4/channels/{channel_id}/members/{user_id}"],
  get_unreads: [
    "GET /api/v4/users/{user_id}/teams/{team_id}/channels/members",
    "GET /api/v4/users/{user_id}/channels/{channel_id}/unread",
  ],
  mark_channel_read: ["POST /api/v4/channels/members/{user_id}/view"],
  upload_file: ["POST /api/v4/files"],
  get_file: ["GET /api/v4/files/{file_id}"],
  get_file_metadata: ["GET /api/v4/files/{file_id}/info"],
};

export function readToolSources(root = REPO_ROOT) {
  const names = ["users", "messaging", "channels", "files", "api"].map(
    (domain) => `src/tools/${domain}.js`,
  );
  return Object.fromEntries(names.map((name) => [name, readFileSync(join(root, name))]));
}

export function annotateToolCoverage(routes, toolSources) {
  const apiFile = "src/tools/api.js";
  const toolNames = (data) =>
    [...data.toString("utf8").matchAll(/\bname:\s*"([a-z_]+)"/g)].map((value) => value[1]);
  const names = Object.entries(toolSources)
    .filter(([name]) => name !== apiFile)
    .flatMap(([, data]) => toolNames(data));
  if (!isDeepStrictEqual(names.sort(), Object.keys(TOOL_ROUTES).sort())) {
    throw new Error("MCP tools changed: review TOOL_ROUTES before updating the audit");
  }
  for (const [tool, keys] of Object.entries(TOOL_ROUTES)) {
    for (const key of keys) {
      if (!routes[key]?.server || !routes[key]?.openapi) {
        throw new Error(`Covered route is not documented and registered: ${tool}: ${key}`);
      }
      (routes[key].mcp_tools ??= []).push(tool);
    }
  }
  const convenienceCovered = Object.values(routes).filter((record) => record.mcp_tools).length;
  const apiNames = toolNames(toolSources[apiFile]);
  if (!isDeepStrictEqual(apiNames.sort(), ["api_call", "api_describe", "api_search"])) {
    throw new Error("Generic API tools changed: review their coverage before updating the audit");
  }
  const callableRoutes = Object.keys(routes)
    .filter(
      (key) =>
        routes[key].server &&
        ["session", "public"].includes(authenticationFamily(routes[key].auth_wrapper)),
    )
    .sort();
  for (const key of callableRoutes) (routes[key].mcp_tools ??= []).push("api_call");
  for (const record of Object.values(routes)) record.mcp_tools?.sort();
  return {
    counts: {
      mcp_tools: Object.keys(TOOL_ROUTES).length + apiNames.length,
      convenience_tools: Object.keys(TOOL_ROUTES).length,
      convenience_covered_routes: convenienceCovered,
      generic_callable_routes: callableRoutes.length,
    },
    tool_routes: sortedObject({
      ...TOOL_ROUTES,
      api_call: callableRoutes,
      api_search: [],
      api_describe: [],
    }),
  };
}
