import { GuardrailError, assertMessageWithinLimit } from "../guardrails.js";

// Verified against the v11.11.1 API handlers pinned by the catalogue. POST is
// otherwise a write: a name such as GetLoginType can conceal sending an email,
// and dialog lookups invoke integrations whose effects we cannot classify.
const readOnlyPostPaths = new Set(
  [
    "/access_control_policies/cel/check",
    "/access_control_policies/cel/simulate_users",
    "/access_control_policies/cel/test",
    "/access_control_policies/cel/validate_requester",
    "/access_control_policies/cel/visual_ast",
    "/access_control_policies/search",
    "/access_control_policies/{policy_id}/resources/channels/search",
    "/channels/group/search",
    "/channels/search",
    "/channels/stats/member_count",
    "/channels/{channel_id}/members/ids",
    "/data_retention/policies/{policy_id}/channels/search",
    "/data_retention/policies/{policy_id}/teams/search",
    "/emoji/names",
    "/emoji/search",
    "/files/search",
    "/groups/names",
    "/license/preview",
    "/logs/query",
    "/permissions/ancillary",
    "/posts/ids",
    "/posts/search",
    "/properties/groups/{group_name}/fields/search",
    "/reports/posts",
    "/roles/names",
    "/teams/search",
    "/teams/{team_id}/channels/ids",
    "/teams/{team_id}/channels/search",
    "/teams/{team_id}/files/search",
    "/teams/{team_id}/members/ids",
    "/teams/{team_id}/posts/search",
    "/users/group_channels",
    "/users/ids",
    "/users/search",
    "/users/status/ids",
    "/users/tokens/search",
    "/users/usernames",
  ].map((path) => `/api/v4${path}`),
);

// Map values indicate whether the mutation also needs destructive confirmation.
// Reveal persists a receipt and starts post expiration. Ping can send a test
// push (device_id) or run write/delete health checks (get_server_status); plain
// ping inherits the same conservative operation-level write/retry policy.
const mutatingGets = new Map([
  ["/api/v4/access_control_policies/{policy_id}/activate", true],
  ["/api/v4/posts/{post_id}/reveal", true],
  ["/api/v4/system/ping", false],
]);

// These mutation families manage security, server configuration, executable
// integrations, or administrative jobs. Their audited read-only POSTs above
// remain reads. Ordinary posts, uploads, membership additions and creates do
// not require the destructive flag merely because they use POST.
const administrativePaths = [
  "/access_control_policies",
  "/audit_logs",
  "/caches",
  "/cloud",
  "/commands",
  "/compliance",
  "/config",
  "/custom_profile_attributes/fields",
  "/data_retention",
  "/database",
  "/elasticsearch",
  "/hooks",
  "/ip_filtering",
  "/jobs",
  "/ldap",
  "/license",
  "/oauth",
  "/plugins",
  "/remotecluster",
  "/roles",
  "/saml",
  "/schemes",
  "/terms_of_service",
  "/users/login",
  "/users/migrate_auth",
  "/users/password",
  "/users/sessions/revoke",
  "/users/tokens",
].map((path) => `/api/v4${path}`);

const destructivePaths = new Set(
  [
    "/actions/dialogs/execute",
    "/actions/dialogs/lookup",
    "/actions/dialogs/submit",
    "/bots/{bot_user_id}/assign/{user_id}",
    "/bots/{bot_user_id}/convert_to_user",
    "/bots/{bot_user_id}/disable",
    "/bots/{bot_user_id}/enable",
    // Full updates and patches can change group constraints, which remove
    // memberships; team updates also change invitation/domain policies.
    "/channels/{channel_id}",
    "/channels/{channel_id}/patch",
    "/channels/{channel_id}/convert_to_channel",
    "/channels/{channel_id}/move",
    "/channels/{channel_id}/privacy",
    "/channels/{channel_id}/restore",
    "/channels/{channel_id}/scheme",
    "/channels/{channel_id}/moderations/patch",
    "/channels/{channel_id}/members/{user_id}/roles",
    "/channels/{channel_id}/members/{user_id}/schemeRoles",
    "/content_flagging/config",
    "/content_flagging/post/{post_id}/keep",
    "/content_flagging/post/{post_id}/remove",
    "/groups/{group_id}/channels/{channel_id}/link",
    "/groups/{group_id}/channels/{channel_id}/patch",
    "/groups/{group_id}/teams/{team_id}/link",
    "/groups/{group_id}/teams/{team_id}/patch",
    "/groups/{group_id}/restore",
    "/posts/{post_id}/actions/{action_id}",
    "/posts/{post_id}/move",
    "/posts/{post_id}/restore/{restore_version_id}",
    "/restart",
    "/server_busy",
    "/teams/{team_id}",
    "/teams/{team_id}/patch",
    "/teams/{team_id}/import",
    "/teams/{team_id}/privacy",
    "/teams/{team_id}/regenerate_invite_id",
    "/teams/{team_id}/restore",
    "/teams/{team_id}/scheme",
    "/teams/{team_id}/members/{user_id}/roles",
    "/teams/{team_id}/members/{user_id}/schemeRoles",
    "/trial-license",
    "/upgrade_to_enterprise",
    "/users/email/verify",
    "/users/logout",
    // User updates can change the account's identity/email, not just its name.
    "/users/{user_id}",
    "/users/{user_id}/patch",
    "/users/{user_id}/active",
    "/users/{user_id}/auth",
    "/users/{user_id}/convert_to_bot",
    "/users/{user_id}/demote",
    "/users/{user_id}/email/verify/member",
    "/users/{user_id}/mfa",
    "/users/{user_id}/mfa/generate",
    "/users/{user_id}/password",
    "/users/{user_id}/preferences/delete",
    "/users/{user_id}/promote",
    "/users/{user_id}/reset_failed_attempts",
    "/users/{user_id}/roles",
    "/users/{user_id}/sessions/revoke",
    "/users/{user_id}/sessions/revoke/all",
    "/users/{user_id}/status/custom/recent/delete",
    "/users/{user_id}/tokens",
  ].map((path) => `/api/v4${path}`),
);

/** Classify trusted catalogue metadata; never accept caller-provided flags. */
export function operationGuard(op) {
  const method = op.method.toUpperCase();
  const mutatingGet = method === "GET" && mutatingGets.has(op.path);
  const read =
    (["GET", "HEAD", "OPTIONS"].includes(method) && !mutatingGet) ||
    (method === "POST" && readOnlyPostPaths.has(op.path));
  if (read) return { write: false, destructive: false };

  const destructive =
    method === "DELETE" ||
    (mutatingGet && mutatingGets.get(op.path)) ||
    administrativePaths.some((path) => op.path === path || op.path.startsWith(`${path}/`)) ||
    destructivePaths.has(op.path) ||
    (method === "PUT" && op.path === "/api/v4/channels/{channel_id}/members");
  return { write: true, destructive };
}

const messageOperations = new Set([
  "POST /api/v4/posts",
  "POST /api/v4/drafts",
  "POST /api/v4/posts/schedule",
  "PUT /api/v4/posts/{post_id}",
  "PUT /api/v4/posts/{post_id}/patch",
  "PUT /api/v4/posts/schedule/{scheduled_post_id}",
]);

function matchingFields(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  // Go's JSON decoder accepts folded field names (including Message and the
  // long-s variant). Checking every match also handles multiple casing aliases.
  return Object.entries(value)
    .filter(([key]) => key.toUpperCase() === name)
    .map(([, field]) => field);
}

/** Resource and credential boundaries, checked before any generic API HTTP. */
export function assertApiAccess(op, args, session) {
  if (op.transport !== "http") {
    throw new GuardrailError(
      "refused: this operation requires Mattermost's local socket; api_call uses the configured HTTP session",
    );
  }
  if (!["session", "public"].includes(op.auth)) {
    throw new GuardrailError(
      `refused: this operation requires '${op.auth}' authentication; api_call only uses the configured Mattermost user session`,
    );
  }

  const guardrails = session.config.guardrails;
  if (guardrails.teamAllowlist.length || guardrails.channelAllowlist.length) {
    throw new GuardrailError(
      "refused: api_call is unavailable while MM_TEAM_ALLOWLIST or MM_CHANNEL_ALLOWLIST is set; use the scoped convenience tools",
    );
  }

  const operation = `${op.method.toUpperCase()} ${op.path}`;
  const ephemeral = operation === "POST /api/v4/posts/ephemeral";
  if (!messageOperations.has(operation) && !ephemeral) return;
  if (args.body_base64 !== undefined || args.body_file_path !== undefined) {
    throw new GuardrailError(
      "refused: message-writing operations require a JSON body to enforce MM_MAX_MESSAGE_LEN",
    );
  }
  const posts = ephemeral ? matchingFields(args.body, "POST") : [args.body];
  for (const post of posts) {
    for (const message of matchingFields(post, "MESSAGE")) {
      if (typeof message === "string") assertMessageWithinLimit(message, guardrails);
    }
  }
}
