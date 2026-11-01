// Reconcile independently extracted OpenAPI and Go evidence against the MCP tool mapping.
import { VERSION, COMMIT, REPOSITORY, sourceHashes } from "./mattermost-source.mjs";
import { compare, documentedRoutes, readOpenApi, sortedObject } from "./inventory/routes.mjs";
import { registeredRoutes } from "./inventory/server-routes.mjs";
import { annotateToolCoverage, readToolSources } from "./inventory/tool-coverage.mjs";

export { readOpenApi, METHODS, routeKey } from "./inventory/routes.mjs";
export { authenticationFamily } from "./inventory/server-routes.mjs";

const scope = {
  unit: "Unique HTTP method + normalized path; /users/me uses /users/{user_id}.",
  included:
    "Documented /api/v4 REST operations plus literal core api4 HTTP route registrations, including conditional registrations. Five documented local-only operations are retained and labeled for comparison, not counted as registered HTTP endpoints.",
  excluded:
    "Local socket routes, /api/v5, plugin-defined APIs, WebSocket operations, root endpoints, and catch-all 404 handlers.",
  permission_metadata:
    "Lexical references only, not an evaluated permission policy. Empty/missing lists do not mean unrestricted access. Handler helpers, app logic, account roles, membership, licenses and configuration remain authoritative.",
  coverage:
    "Convenience tools cover 33 method/path pairs; api_call dispatches every session/public core HTTP operation through a pinned catalog. api_search and api_describe are local discovery only. Special cloud/remote-cluster authentication and local-socket operations are catalogued but cannot use the configured account credential. Coverage is transport exposure, not a claim that every PAT has the required account permissions, license, features, input variants or live compatibility.",
};
const count = (values, predicate) => values.filter(predicate).length;
const shape = (key) => key.replace(/\{[^{}]+\}/g, "{}");

function reconcileRoutes(docs, server, local) {
  const docShapes = Object.fromEntries(Object.keys(docs).map((key) => [shape(key), key]));
  if (
    Object.keys(docShapes).length !== Object.keys(docs).length ||
    new Set(Object.keys(server).map(shape)).size !== Object.keys(server).length
  ) {
    throw new Error("Duplicate OpenAPI shapes need review");
  }
  const routes = structuredClone(docs);
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
  return routes;
}

function summarize({ routes, server, docs, docsV4, docsRest, coverage }) {
  const records = Object.values(routes);
  return {
    ...coverage.counts,
    special_auth_http_routes: Object.keys(server).length - coverage.counts.generic_callable_routes,
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
}

function wrapperCounts(server) {
  const totals = {};
  for (const { auth_wrapper } of Object.values(server)) {
    totals[auth_wrapper] = (totals[auth_wrapper] ?? 0) + 1;
  }
  return sortedObject(totals);
}

// Tool source bytes are injectable for parity checks; the CLI always reads the
// current JavaScript source files and records their actual paths and hashes.
export function buildInventory(
  files,
  { toolSources = readToolSources(), specs = readOpenApi(files) } = {},
) {
  const docs = documentedRoutes(specs);
  const { routes: server, excluded, local } = registeredRoutes(files);
  const docsV4 = Object.fromEntries(
    Object.entries(docs).filter(([key]) => key.split(" ", 2)[1].startsWith("/api/v4/")),
  );
  const docsRest = Object.fromEntries(
    Object.entries(docsV4).filter(([key]) => key !== "GET /api/v4/websocket"),
  );
  const routes = reconcileRoutes(docsRest, server, local);
  const coverage = annotateToolCoverage(routes, toolSources);
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
    scope: { ...scope },
    mcp_source_sha256: sourceHashes(toolSources),
    counts: summarize({ routes, server, docs, docsV4, docsRest, coverage }),
    registered_auth_wrapper_counts: wrapperCounts(server),
    tool_routes: coverage.tool_routes,
    routes: sortedObject(routes),
    documented_excluded: Object.fromEntries(
      Object.entries(docs).filter(([key]) => !Object.hasOwn(docsRest, key)),
    ),
    registered_excluded: excluded.sort((a, b) => compare(a.route, b.route)),
  };
}
