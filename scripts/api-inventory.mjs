// Build the independent core-route and convenience-tool coverage inventory.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml } from "yaml";
import { VERSION, COMMIT, REPOSITORY, REPO_ROOT, sourceHashes } from "./mattermost-source.mjs";

export const METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "TRACE",
]);
const GO_STRING = '(?:"(?:[^"\\\\]|\\\\.)*"|`[^`]*`)';

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

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sortedEntries = (object) => Object.entries(object).sort(([a], [b]) => compare(a, b));
const sortedObject = (object) => Object.fromEntries(sortedEntries(object));
const uniqueSorted = (values) => [...new Set(values)].sort();
const count = (values, predicate) => values.filter(predicate).length;
const AUTH = {
  APIHandler: "public",
  APIHandlerTrustRequester: "public",
  APISessionRequired: "session",
  APISessionRequiredTrustRequester: "session",
  APISessionRequiredDisableWhenBusy: "session",
  APISessionRequiredMfa: "session",
  CloudAPIKeyRequired: "cloud",
  RemoteClusterTokenRequired: "remote_cluster",
  APILocal: "local",
};

export function authenticationFamily(wrapper) {
  if (!Object.hasOwn(AUTH, wrapper)) throw new Error(`Unknown authentication wrapper: ${wrapper}`);
  return AUTH[wrapper];
}

export function readOpenApi(files) {
  return Object.fromEntries(
    sortedEntries(files)
      .filter(([name]) => name.endsWith(".yaml"))
      .map(([name, data]) => [
        name,
        parseYaml(data.toString("utf8"), { version: "1.1", uniqueKeys: false }),
      ]),
  );
}

export const routeKey = (method, path) => `${method.toUpperCase()} ${path.replace(/\/+$/, "")}`;
const shape = (key) => key.replace(/\{[^{}]+\}/g, "{}");
const goString = (literal) =>
  literal.startsWith("`") ? literal.slice(1, -1) : JSON.parse(literal);

function documentedRoutes(specs) {
  const routes = {};
  for (const [filename, spec] of Object.entries(specs)) {
    for (const [path, item] of Object.entries(spec)) {
      if (!path.startsWith("/")) continue;
      for (const [method, operation] of Object.entries(item)) {
        if (!METHODS.has(method.toUpperCase())) continue;
        const key = routeKey(method, path);
        if (Object.hasOwn(routes, key)) throw new Error(`Duplicate OpenAPI route: ${key}`);
        const record = {
          operation_id: operation.operationId,
          openapi: filename,
          tags: operation.tags ?? [],
        };
        const description = operation.description ?? "";
        const permissionSection = description.match(/#+\s*Permissions\s*\n(.*?)(?=\n#+\s|$)/is);
        if (permissionSection) {
          const terms = [...permissionSection[1].matchAll(/`([a-z][a-z0-9_]+)`/g)].map(
            (match) => match[1],
          );
          if (terms.length) record.documented_permission_terms = uniqueSorted(terms);
        }
        const minimum = description.match(/Minimum server version[_*\s:]*([0-9]+(?:\.[0-9]+)*)/i);
        if (minimum) record.documented_minimum_version = minimum[1];
        if (operation.deprecated) record.deprecated = true;
        routes[key] = record;
      }
    }
  }
  return routes;
}

function functions(text) {
  const declarations = [...text.matchAll(/^func\s+(?:\([^\n]*?\)\s+)?(\w+)\s*\(/gm)];
  return declarations.map((match, index) => [
    match[1],
    text.slice(match.index, declarations[index + 1]?.index ?? text.length),
    match.index,
  ]);
}

function registeredRoutes(files) {
  const init = functions(files["server/channels/api4/api.go"].toString("utf8")).find(
    ([name]) => name === "Init",
  )?.[1];
  if (!init) throw new Error("Missing API initialization function");
  const prefixes = { Root: "", APIRoot: "/api/v4", APIRoot5: "/api/v5" };
  const assignment = new RegExp(
    `api\\.BaseRoutes\\.(\\w+)\\s*=\\s*api\\.BaseRoutes\\.(\\w+)\\.PathPrefix\\((${GO_STRING})\\)\\.Subrouter\\(\\)`,
    "g",
  );
  for (const match of init.matchAll(assignment)) {
    if (!Object.hasOwn(prefixes, match[2])) throw new Error(`Unknown route prefix: ${match[2]}`);
    prefixes[match[1]] = prefixes[match[2]] + goString(match[3]);
  }
  const registration = new RegExp(
    `api\\.BaseRoutes\\.(\\w+)\\.Handle\\((${GO_STRING}),\\s*(.*?)\\)\\.Methods\\(([^)]*)\\)`,
    "gs",
  );
  const routes = {};
  const excluded = [];
  const local = {};
  for (const [filename, data] of sortedEntries(files)) {
    if (!filename.endsWith(".go")) continue;
    const text = data.toString("utf8");
    const declared = functions(text);
    const bodies = Object.fromEntries(declared.map(([name, body]) => [name, body]));
    for (const [name, body, offset] of declared) {
      const isLocal = name.includes("Local") || filename.endsWith("_local.go");
      if (!body.includes("api.BaseRoutes.") || !body.includes(".Handle(")) continue;
      if (!name.startsWith("Init") && !name.startsWith("init")) {
        throw new Error(`Review unexpected registration function: ${filename}:${name}`);
      }
      const matches = [...body.matchAll(registration)];
      if (matches.length !== [...body.matchAll(/api\.BaseRoutes\.\w+\.Handle\(/g)].length) {
        throw new Error(`Unparsed registration: ${filename}:${name}`);
      }
      for (const match of matches) {
        if (!Object.hasOwn(prefixes, match[1]))
          throw new Error(`Unknown route prefix: ${match[1]}`);
        const rawPath = prefixes[match[1]] + goString(match[2]);
        const wrappers = [
          ...match[3].matchAll(
            /api\.(API\w+|CloudAPIKeyRequired|RemoteClusterTokenRequired)\((\w+(?:\.\w+)?)/g,
          ),
        ];
        if (wrappers.length !== 1)
          throw new Error(`Review authentication wrapper: ${filename}:${match[0]}`);
        const [, wrapper, handler] = wrappers[0];
        const methods = [...match[4].matchAll(/http\.Method(\w+)|"([A-Z]+)"/g)].map(
          (value) => value[1] || value[2],
        );
        if (!methods.length || methods.some((method) => !METHODS.has(method.toUpperCase()))) {
          throw new Error(`Unparsed methods: ${filename}:${match[0]}`);
        }
        const line = text.slice(0, offset + match.index).split("\n").length;
        const paths = rawPath.includes("{syncable_type:teams|channels}")
          ? ["teams", "channels"].map((kind) =>
              rawPath.replace("{syncable_type:teams|channels}", kind),
            )
          : [rawPath];
        for (const rawVariant of paths) {
          const path = rawVariant.replace(/\{(\w+):[^{}]*\}/g, "{$1}");
          for (const method of methods) {
            const key = routeKey(method, path);
            const record = { server: `${filename}:${line}`, handler, auth_wrapper: wrapper };
            if (isLocal) {
              local[key] = record;
              continue;
            }
            if (!path.startsWith("/api/v4/") || handler === "connectWebSocket") {
              excluded.push({
                route: key,
                ...record,
                reason: handler === "connectWebSocket" ? "websocket" : "outside_v4",
              });
              continue;
            }
            const handlerBody = bodies[handler] ?? "";
            const permissions = [...handlerBody.matchAll(/model\.(Permission\w+)/g)].map(
              (value) => value[1],
            );
            if (permissions.length) record.server_permission_constants = uniqueSorted(permissions);
            const settings = [...handlerBody.matchAll(/Config\(\)\.(\w+)\.(\w+)/g)].map(
              (value) => `${value[1]}.${value[2]}`,
            );
            if (settings.length) record.server_config_references = uniqueSorted(settings);
            if (
              ["InitProperties", "initChannelJoinRequestRoutes"].includes(name) ||
              handler === "getManagedCategories"
            ) {
              record.registration_feature_flags = uniqueSorted(
                [...body.matchAll(/FeatureFlags\.(\w+)/g)].map((value) => value[1]),
              );
            }
            if (Object.hasOwn(routes, key)) throw new Error(`Duplicate server route: ${key}`);
            routes[key] = record;
          }
        }
      }
    }
  }
  return [routes, excluded, local];
}

function readToolSources(root = REPO_ROOT) {
  const names = ["users", "messaging", "channels", "files", "api"].map(
    (domain) => `src/tools/${domain}.js`,
  );
  return Object.fromEntries(names.map((name) => [name, readFileSync(join(root, name))]));
}

// Tool source bytes are injectable for parity checks; the CLI always reads the
// current JavaScript source files and records their actual paths and hashes.
export function buildInventory(
  files,
  { toolSources = readToolSources(), specs = readOpenApi(files) } = {},
) {
  const docs = documentedRoutes(specs);
  const [server, excluded, local] = registeredRoutes(files);
  const docsV4 = Object.fromEntries(
    Object.entries(docs).filter(([key]) => key.split(" ", 2)[1].startsWith("/api/v4/")),
  );
  const docsRest = Object.fromEntries(
    Object.entries(docsV4).filter(([key]) => key !== "GET /api/v4/websocket"),
  );
  const docShapes = Object.fromEntries(Object.keys(docsRest).map((key) => [shape(key), key]));
  if (
    Object.keys(docShapes).length !== Object.keys(docsRest).length ||
    new Set(Object.keys(server).map(shape)).size !== Object.keys(server).length
  ) {
    throw new Error("Duplicate OpenAPI shapes need review");
  }
  const routes = structuredClone(docsRest);
  for (const [key, record] of Object.entries(server)) {
    const canonical = docShapes[shape(key)] ?? key;
    Object.assign((routes[canonical] ??= {}), record);
  }
  const localShapes = Object.fromEntries(
    Object.entries(local).map(([key, value]) => [shape(key), value]),
  );
  for (const [key, record] of Object.entries(routes)) {
    if (!record.server && Object.hasOwn(localShapes, shape(key)))
      record.local_socket_only = localShapes[shape(key)];
  }
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
  const convenienceCovered = count(Object.values(routes), (record) => !!record.mcp_tools);
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
  const records = Object.values(routes);
  const counts = {
    mcp_tools: Object.keys(TOOL_ROUTES).length + apiNames.length,
    convenience_tools: Object.keys(TOOL_ROUTES).length,
    convenience_covered_routes: convenienceCovered,
    generic_callable_routes: callableRoutes.length,
    special_auth_http_routes: Object.keys(server).length - callableRoutes.length,
    covered_routes: count(records, (record) => !!record.mcp_tools),
    documented_operations_all_paths: Object.keys(docs).length,
    documented_v4_operations: Object.keys(docsV4).length,
    documented_v4_rest_operations: Object.keys(docsRest).length,
    registered_core_v4_rest_operations: Object.keys(server).length,
    documented_and_registered: count(records, (record) => !!record.openapi && !!record.server),
    documented_without_core_registration: count(records, (record) => !record.server),
    registered_without_openapi: count(records, (record) => !record.openapi),
    documented_local_socket_only: count(records, (record) => !!record.local_socket_only),
    inventory_union: records.length,
  };
  return {
    schema_version: 2,
    source: {
      mattermost_version: VERSION,
      tag: `v${VERSION}`,
      commit: COMMIT,
      repository: REPOSITORY,
      openapi_url: `${REPOSITORY}/tree/${COMMIT}/api/v4/source`,
      server_url: `${REPOSITORY}/tree/${COMMIT}/server/channels/api4`,
      source_sha256: sourceHashes(files),
    },
    scope: {
      unit: "Unique HTTP method + normalized path; /users/me uses /users/{user_id}.",
      included:
        "Documented /api/v4 REST operations plus literal core api4 HTTP route registrations, including conditional registrations. Five documented local-only operations are retained and labeled for comparison, not counted as registered HTTP endpoints.",
      excluded:
        "Local socket routes, /api/v5, plugin-defined APIs, WebSocket operations, root endpoints, and catch-all 404 handlers.",
      permission_metadata:
        "Lexical references only, not an evaluated permission policy. Empty/missing lists do not mean unrestricted access. Handler helpers, app logic, account roles, membership, licenses and configuration remain authoritative.",
      coverage:
        "Convenience tools cover 33 method/path pairs; api_call dispatches every session/public core HTTP operation through a pinned catalog. api_search and api_describe are local discovery only. Special cloud/remote-cluster authentication and local-socket operations are catalogued but cannot use the configured account credential. Coverage is transport exposure, not a claim that every PAT has the required account permissions, license, features, input variants or live compatibility.",
    },
    mcp_source_sha256: sourceHashes(toolSources),
    counts,
    registered_auth_wrapper_counts: Object.fromEntries(
      uniqueSorted(Object.values(server).map((record) => record.auth_wrapper)).map((wrapper) => [
        wrapper,
        count(Object.values(server), (record) => record.auth_wrapper === wrapper),
      ]),
    ),
    tool_routes: sortedObject({
      ...TOOL_ROUTES,
      api_call: callableRoutes,
      api_search: [],
      api_describe: [],
    }),
    routes: sortedObject(routes),
    documented_excluded: Object.fromEntries(
      Object.entries(docs).filter(([key]) => !Object.hasOwn(docsRest, key)),
    ),
    registered_excluded: excluded.sort((a, b) => compare(a.route, b.route)),
  };
}
