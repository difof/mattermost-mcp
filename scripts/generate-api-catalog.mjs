#!/usr/bin/env node
// Generate the pinned REST catalog with Node + the development-only YAML parser.
// Run audit-api-coverage.mjs first. --check verifies source, inventory and catalog
// without rewriting artifacts or contacting a Mattermost deployment.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import * as audit from "./audit-api-coverage.mjs";

// Supplemental sources used by the explicit corrections, all from the same
// immutable revision as the independently authenticated 149-file base audit.
export const EXTRA_SOURCES = {
  "server/public/model/channel_join_request.go":
    "fc88cb8900da9f7ffb890ea7f4cb271ece0640d04ced3c40ea49e73625a7890d",
  "server/channels/app/channel_join_request.go":
    "01a1be0f15f19a0daa7eec8c3a29ee04d87af778d6e68313936a09be96b7f7b4",
  "server/channels/web/params.go":
    "b761869701e7807037a03aa4219384e2cd0bae06dd8d4fdebd2483b31053dfbe",
  "server/public/model/group_syncable.go":
    "5930f6cd2e46b604c59f7bc1665311e5c411d3800900c897d34d4395559f72b4",
  "server/public/model/integration_action.go":
    "e5840e59ed2d7d6d96e60e008b8f417928d0a6e4eefd6d4bf11d170e096093cc",
  "server/public/model/push_notification.go":
    "797ff3e676f8bb666a0111e2fadc1d204ae22d35a8daeea8a0222035accc0e17",
  "server/public/model/cloud.go":
    "12313744c6729f14dd7fbd8da9ed553c8d4b7ae50102f07f452e858f6369ea1a",
};
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
const uniqueSorted = (values) => [...new Set(values)].sort();
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });

export async function supplementalSource(directory, download = false, checkout = false) {
  if (
    checkout &&
    audit.git(directory, "status", "--porcelain", "--", ...Object.keys(EXTRA_SOURCES))
  ) {
    throw new Error("Supplemental source files have checkout changes");
  }
  const files = await Promise.all(
    Object.entries(EXTRA_SOURCES).map(async ([name, expected]) => {
      const target = join(directory, name);
      let data = existsSync(target) ? readFileSync(target) : Buffer.alloc(0);
      if (audit.digest(data) !== expected && download) {
        data = await audit.request(
          `https://raw.githubusercontent.com/mattermost/mattermost/${audit.COMMIT}/${name}`,
        );
        if (audit.digest(data) === expected) {
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, data);
        }
      }
      if (audit.digest(data) !== expected)
        throw new Error(`Supplemental source hash mismatch or missing file: ${name}`);
      return [name, data];
    }),
  );
  return Object.fromEntries(files);
}

function objectSchema(properties, required = []) {
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

function jsonBody(schema, required = true, description) {
  return {
    required,
    content: { "application/json": { schema } },
    ...(description ? { description } : {}),
  };
}

function jsonResponse(schema, description) {
  return { description, content: { "application/json": { schema } } };
}

function parameter(name, schema, description = "", required = false) {
  return { name, in: "query", required, schema, ...(description ? { description } : {}) };
}

export function buildCatalog(files, inventory, extra) {
  const specs = Object.fromEntries(
    Object.entries(files)
      .filter(([name]) => name.endsWith(".yaml"))
      .map(([name, data]) => [name, audit.parseSourceYaml(data)]),
  );
  const definitions = specs["api/v4/source/definitions.yaml"].components;
  const components = structuredClone({
    schemas: definitions.schemas,
    responses: definitions.responses,
  });
  const documents = {};
  for (const spec of Object.values(specs)) {
    for (const [path, item] of Object.entries(spec)) {
      if (!path.startsWith("/")) continue;
      for (const [method, definition] of Object.entries(item)) {
        if (!audit.METHODS.has(method.toUpperCase())) continue;
        const operation = structuredClone(definition);
        operation.parameters = [
          ...structuredClone(item.parameters ?? []),
          ...(operation.parameters ?? []),
        ];
        documents[audit.routeKey(method, path)] = operation;
      }
    }
  }
  const operations = {};
  const corrections = [];
  const correct = (routes, reason, sources) =>
    corrections.push({ operations: routes, reason, sources });
  for (const [key, record] of Object.entries(inventory.routes)) {
    const [method, path] = key.split(" ", 2);
    const server = record.local_socket_only ?? record;
    const wrapper = server.auth_wrapper;
    if (!Object.hasOwn(AUTH, wrapper))
      throw new Error(`Unknown authentication wrapper: ${wrapper}`);
    const auth = AUTH[wrapper];
    const document = documents[key] ?? {};
    const operation = { method, path };
    for (const field of ["operationId", "summary", "description", "tags", "deprecated"]) {
      if (Object.hasOwn(document, field)) operation[field] = document[field];
    }
    if (!Object.hasOwn(operation, "summary")) {
      const words = server.handler.replace(/(?<!^)([A-Z])/g, " $1");
      operation.summary = words[0].toUpperCase() + words.slice(1).toLowerCase();
    }
    operation.tags ??= [path.split("/")[3]];
    Object.assign(operation, {
      auth,
      transport: auth === "local" ? "local" : "http",
      parameters: document.parameters ?? [],
      responses: { ...(document.responses ?? {}) },
      source: {
        ...(record.openapi ? { openapi: record.openapi } : {}),
        server: server.server,
        handler: server.handler,
        authWrapper: wrapper,
      },
    });
    if (Object.hasOwn(document, "requestBody")) operation.requestBody = document.requestBody;
    for (const [old, name] of [
      ["server_permission_constants", "permissionReferences"],
      ["server_config_references", "configurationReferences"],
      ["registration_feature_flags", "featureFlags"],
    ]) {
      if (Object.hasOwn(record, old)) operation.source[name] = record[old];
    }
    const names = new Set(operation.parameters.filter((p) => p.in === "path").map((p) => p.name));
    const missing = [...path.matchAll(/\{([^{}]+)\}/g)]
      .map((match) => match[1])
      .filter((name) => !names.has(name));
    for (const name of missing)
      operation.parameters.push({ name, in: "path", required: true, schema: { type: "string" } });
    if (missing.length && Object.keys(document).length) {
      correct([key], `Declare missing required path parameter(s): ${missing.join(", ")}.`, [
        server.server,
      ]);
    }
    operations[key] = operation;
  }

  // Corrections address observed disagreements with the pinned server. They do
  // not claim to enumerate every field the Go validators accept.
  const searchRoutes = ["POST /api/v4/files/search", "POST /api/v4/teams/{team_id}/files/search"];
  for (const key of searchRoutes) {
    const body = operations[key].requestBody;
    body.content["application/json"] = body.content["multipart/form-data"];
    delete body.content["multipart/form-data"];
    body.content["application/json"].schema.required = ["terms"];
  }
  correct(
    searchRoutes,
    "File search decodes JSON; only terms is required. is_or_search defaults to false.",
    ["server/channels/api4/file.go:961"],
  );

  const upload = operations["POST /api/v4/files"];
  upload.requestBody.content["application/octet-stream"] = {
    schema: { type: "string", format: "binary" },
  };
  upload.requestBody.description =
    "Multipart upload with files and channel_id, or raw file bytes with required channel_id and filename query parameters. Raw uploads may also specify client_id. Use bookmark=true for bookmark attachments.";
  upload.parameters.push(
    parameter(
      "client_id",
      { type: "string" },
      "Optional client identifier for the raw upload mode.",
    ),
    parameter("bookmark", { type: "boolean" }, "Upload a channel bookmark attachment."),
  );
  correct(
    ["POST /api/v4/files"],
    "Advertise the raw binary upload mode in addition to multipart and its optional query fields.",
    ["server/channels/api4/file.go:79", "server/channels/api4/file.go:134"],
  );

  const missingBodies = {
    "POST /api/v4/cloud/webhook": jsonBody(
      objectSchema({ event: { type: "string" } }),
      true,
      "Cloud service webhook payload; additional event-specific fields are accepted. Requires the cloud API key, not the account token.",
    ),
    "POST /api/v4/compliance/reports": jsonBody(ref("Compliance")),
    "POST /api/v4/elasticsearch/test": jsonBody(
      ref("Config"),
      false,
      "Optional configuration; the handler falls back to the current configuration when absent or undecodable.",
    ),
    "POST /api/v4/notifications/ack": jsonBody(
      objectSchema({
        id: { type: "string" },
        received_at: { type: "integer", format: "int64" },
        platform: { type: "string" },
        type: { type: "string" },
        post_id: { type: "string" },
        is_id_loaded: { type: "boolean" },
      }),
    ),
    "POST /api/v4/posts/{post_id}/actions/{action_id}": jsonBody(
      objectSchema({
        selected_option: { type: "string" },
        cookie: { type: "string" },
        query: { type: "object", additionalProperties: { type: "string" } },
        integration_format: {
          type: "string",
          description:
            "attachment (default), apps_binding, block, card or mm_block; unrecognized values fall back to attachment.",
        },
      }),
      false,
      "Empty body is allowed for older interactive integrations.",
    ),
    "POST /api/v4/terms_of_service": jsonBody(objectSchema({ text: { type: "string" } }, ["text"])),
    "POST /api/v4/users/{user_id}/posts/{post_id}/set_unread": jsonBody(
      objectSchema({ collapsed_threads_supported: { type: "boolean" } }),
      false,
    ),
  };
  for (const kind of ["teams", "channels"]) {
    const key = `POST /api/v4/groups/{group_id}/${kind}/{${kind.slice(0, -1)}_id}/link`;
    missingBodies[key] = jsonBody(
      objectSchema({
        auto_add: { type: "boolean", nullable: true },
        scheme_admin: { type: "boolean", nullable: true },
      }),
    );
  }
  for (const [key, body] of Object.entries(missingBodies)) {
    if (Object.hasOwn(operations[key], "requestBody"))
      throw new Error(
        `Previously missing request body now documented: review correction for ${key}`,
      );
    operations[key].requestBody = body;
  }
  correct(
    Object.keys(missingBodies).sort(),
    "Describe JSON bodies parsed by handlers but absent from OpenAPI. These schemas intentionally allow additional fields.",
    [
      ...uniqueSorted(Object.keys(missingBodies).map((key) => operations[key].source.server)),
      "server/public/model/group_syncable.go",
      "server/public/model/integration_action.go",
      "server/public/model/push_notification.go",
      "server/public/model/cloud.go",
    ],
  );

  const purge = operations["POST /api/v4/elasticsearch/purge_indexes"];
  purge.parameters.push({
    ...parameter(
      "index",
      { type: "array", items: { type: "string" } },
      "Repeat index for each selected index; omission uses the handler's default index set.",
    ),
    style: "form",
    explode: true,
  });
  correct(
    ["POST /api/v4/elasticsearch/purge_indexes"],
    "Document the repeated index query parameter read by the handler.",
    [purge.source.server],
  );

  const activation = operations["GET /api/v4/access_control_policies/{policy_id}/activate"];
  const active = activation.parameters.find((p) => p.name === "active" && p.in === "query");
  const wantedActive = parameter(
    "active",
    { type: "boolean" },
    "Required true or false. This deprecated GET mutates the policy and requires header-based authentication.",
    true,
  );
  if (active) Object.assign(active, wantedActive);
  else activation.parameters.push(wantedActive);
  correct(
    ["GET /api/v4/access_control_policies/{policy_id}/activate"],
    "Activation consumes a required active query parameter, never a GET body; cookie authentication is rejected.",
    ["server/channels/api4/access_control.go:838"],
  );

  const custom =
    operations["GET /api/v4/users/{user_id}/custom_profile_attributes"].responses["200"].content;
  custom["application/json"] = { schema: custom.schema };
  delete custom.schema;
  correct(
    ["GET /api/v4/users/{user_id}/custom_profile_attributes"],
    "Repair the response schema's misplaced indentation under content/application/json.",
    [operations["GET /api/v4/users/{user_id}/custom_profile_attributes"].source.openapi],
  );

  const binary = {
    "/api/v4/files/{file_id}": "application/octet-stream",
    "/api/v4/files/{file_id}/thumbnail": "image/jpeg",
    "/api/v4/files/{file_id}/preview": "image/jpeg",
    "/api/v4/exports/{export_name}": "application/zip",
    "/api/v4/brand/image": "image/png",
    "/api/v4/users/{user_id}/image": "image/png",
    "/api/v4/users/{user_id}/image/default": "image/png",
    "/api/v4/teams/{team_id}/image": "image/png",
    "/api/v4/emoji/{emoji_id}/image": "image/*",
    "/api/v4/compliance/reports/{report_id}/download": "application/octet-stream",
  };
  for (const [path, media] of Object.entries(binary)) {
    operations[`GET ${path}`].responses["200"] = {
      description: "Raw file bytes; the actual Content-Type depends on the file.",
      content: { [media]: { schema: { type: "string", format: "binary" } } },
    };
    if (Object.hasOwn(operations, `HEAD ${path}`)) {
      operations[`HEAD ${path}`].responses["200"] = {
        description: "File headers only; no response body.",
      };
    }
  }
  correct(
    [
      ...Object.keys(binary)
        .map((path) => `GET ${path}`)
        .sort(),
      ...Object.keys(binary)
        .filter((path) => Object.hasOwn(operations, `HEAD ${path}`))
        .map((path) => `HEAD ${path}`)
        .sort(),
    ],
    "Declare binary success responses and bodyless HEAD success where OpenAPI omitted or mislabeled them. Response decoding uses the actual HTTP Content-Type.",
    uniqueSorted(Object.keys(binary).map((path) => operations[`GET ${path}`].source.server)),
  );

  addJoinRequests(operations, components);
  const joinRoutes = Object.entries(inventory.routes)
    .filter(([, record]) => !Object.hasOwn(record, "openapi"))
    .map(([key]) => key)
    .sort();
  correct(
    joinRoutes,
    "Derive all seven discoverable-private-channel join-request contracts from the registered handlers, models and app validation because this revision's OpenAPI omits them.",
    [
      "server/channels/api4/channel_join_request.go",
      "server/public/model/channel_join_request.go",
      "server/channels/app/channel_join_request.go",
      "server/channels/web/params.go",
    ],
  );

  const catalog = {
    version: audit.VERSION,
    source: {
      ...inventory.source,
      supplemental_source_sha256: Object.fromEntries(
        audit.sortedEntries(extra).map(([name, data]) => [name, audit.digest(data)]),
      ),
      scope:
        "601 inventoried core REST operations: 590 session/public HTTP, 6 special-auth HTTP, 5 documented local-socket operations. No plugin, WebSocket, /api/v5 or root routes.",
      authentication:
        "auth is the route wrapper's credential family, not an evaluated permission grant. Public wrappers may require endpoint-specific credentials. Handler checks, account roles, membership, MFA, licenses, server settings and feature flags remain authoritative.",
      schema_limitations:
        "OpenAPI plus explicit source-backed corrections; not an exhaustive schema for every server-accepted field or deployment response. Undocumented body/query fields may be needed. References are preserved for lazy transitive schema discovery.",
    },
    operations: audit.sortedObject(operations),
    components,
    corrections,
  };
  validateCatalog(catalog, inventory);
  return catalog;
}

function addJoinRequests(operations, components) {
  const statuses = ["pending", "approved", "denied", "withdrawn"];
  const properties = {
    ...Object.fromEntries(
      ["id", "channel_id", "user_id", "reviewed_by"].map((key) => [key, { type: "string" }]),
    ),
    message: { type: "string", maxLength: 500 },
    status: { type: "string", enum: statuses },
    denial_reason: { type: "string", maxLength: 500 },
    ...Object.fromEntries(
      ["create_at", "update_at", "reviewed_at"].map((key) => [
        key,
        {
          type: "integer",
          format: "int64",
          description: "Unix milliseconds; reviewed_at is zero before review.",
        },
      ]),
    ),
  };
  components.schemas.ChannelJoinRequest = objectSchema(properties, Object.keys(properties));
  components.schemas.ChannelJoinRequestList = objectSchema(
    {
      requests: { type: "array", items: ref("ChannelJoinRequest") },
      total_count: { type: "integer", format: "int64" },
    },
    ["requests", "total_count"],
  );
  const listing = [
    parameter(
      "status",
      { type: "string", enum: statuses, default: "pending" },
      "Missing or unrecognized status defaults to pending.",
    ),
    parameter(
      "page",
      { type: "integer", minimum: 0, default: 0 },
      "Negative values are clamped to zero.",
    ),
    parameter(
      "per_page",
      { type: "integer", minimum: 1, maximum: 200, default: 60 },
      "Nonpositive values use 60; values above 200 are clamped.",
    ),
  ];
  const request = "/api/v4/channels/{channel_id}/join_request";
  const queue = "/api/v4/channels/{channel_id}/join_requests";
  const definitions = {
    [`POST ${request}`]: [
      "Request to join a discoverable private channel",
      "201",
      {
        oneOf: [
          ref("ChannelJoinRequest"),
          objectSchema({ status: { type: "string", enum: ["approved"] } }, ["status"]),
        ],
      },
    ],
    [`GET ${request}`]: [
      "Get my pending request to join a channel",
      "200",
      ref("ChannelJoinRequest"),
    ],
    [`DELETE ${request}`]: [
      "Withdraw my pending channel join request",
      "200",
      ref("ChannelJoinRequest"),
    ],
    [`GET ${queue}`]: ["List a channel's join requests", "200", ref("ChannelJoinRequestList")],
    [`GET ${queue}/count`]: [
      "Count a channel's pending join requests",
      "200",
      objectSchema({ count: { type: "integer", format: "int64" } }, ["count"]),
    ],
    [`PATCH ${queue}/{request_id}`]: [
      "Approve or deny a pending channel join request",
      "200",
      ref("ChannelJoinRequest"),
    ],
    "GET /api/v4/users/{user_id}/channel_join_requests": [
      "List my channel join requests",
      "200",
      ref("ChannelJoinRequestList"),
    ],
  };
  for (const [key, [summary, status, schema]] of Object.entries(definitions)) {
    const operation = operations[key];
    operation.summary = summary;
    operation.tags = ["channels", "join_requests"];
    operation.description =
      "Requires the DiscoverableChannels feature flag. Server membership, account and channel policy checks apply.";
    operation.responses = {
      [status]: jsonResponse(schema, "Successful channel join-request operation."),
      ...Object.fromEntries(
        ["400", "401", "403", "404", "409", "500"].map((code) => [
          code,
          jsonResponse(ref("AppError"), "Mattermost application error."),
        ]),
      ),
    };
    if ([`GET ${queue}`, "GET /api/v4/users/{user_id}/channel_join_requests"].includes(key))
      operation.parameters.push(...structuredClone(listing));
    if (key.startsWith(`GET ${queue}`) || key.startsWith(`PATCH ${queue}`)) {
      operation.description +=
        " Requires manage_channel_join_requests permission for this channel.";
    }
  }
  operations[`POST ${request}`].requestBody = jsonBody(
    objectSchema({ message: { type: "string", maxLength: 500 } }),
    true,
    "An empty JSON object is valid. The ABAC fast path may directly join the caller and return status approved.",
  );
  operations[`GET ${request}`].responses["404"] = {
    description:
      "Empty body when no pending request exists; other not-found errors may contain a Mattermost AppError.",
    content: { "application/json": { schema: ref("AppError") } },
  };
  operations[`PATCH ${queue}/{request_id}`].requestBody = jsonBody(
    objectSchema(
      {
        status: { type: "string", enum: ["approved", "denied"] },
        denial_reason: {
          type: "string",
          nullable: true,
          maxLength: 500,
          description: "Used when denying; ignored when approving.",
        },
      },
      ["status"],
    ),
  );
  operations["GET /api/v4/users/{user_id}/channel_join_requests"].description +=
    " The user_id must identify the authenticated caller, including for administrators; use me for the current user.";
}

export function validateCatalog(catalog, inventory) {
  if (
    !isDeepStrictEqual(Object.keys(catalog.operations).sort(), Object.keys(inventory.routes).sort())
  ) {
    throw new Error("Catalog does not cover exactly the independently audited route universe");
  }
  const available = Object.values(catalog.operations).filter(
    (op) => op.transport === "http" && ["session", "public"].includes(op.auth),
  ).length;
  if (available !== inventory.counts.generic_callable_routes) {
    throw new Error(
      "Catalog account-callable count differs from independently audited wrapper coverage",
    );
  }
  const walk = (value) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === "object") {
      if (Object.hasOwn(value, "$ref")) {
        const reference = value.$ref;
        if (!reference.startsWith("#/components/"))
          throw new Error(`Nonlocal catalog reference needs review: ${reference}`);
        let target = catalog;
        for (const part of reference.slice(2).split("/")) {
          const name = part.replace(/~1/g, "/").replace(/~0/g, "~");
          if (!target || !Object.hasOwn(target, name))
            throw new Error(`Unresolved catalog reference: ${reference}`);
          target = target[name];
        }
      }
      Object.values(value).forEach(walk);
    }
  };
  walk(catalog);
  for (const [key, operation] of Object.entries(catalog.operations)) {
    const expected = uniqueSorted(
      [...operation.path.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]),
    );
    const actual = uniqueSorted(
      operation.parameters.filter((p) => p.in === "path" && p.required).map((p) => p.name),
    );
    if (!isDeepStrictEqual(expected, actual))
      throw new Error(`Path parameter schema mismatch: ${key}`);
    if (["GET", "HEAD"].includes(operation.method) && Object.hasOwn(operation, "requestBody")) {
      throw new Error(`GET/HEAD request body needs source review: ${key}`);
    }
  }
}

export async function main() {
  const args = audit.sourceArguments({
    inventory: { type: "string", default: join(audit.REPO_ROOT, "docs/api-coverage.json") },
    output: { type: "string", default: join(audit.REPO_ROOT, "src/api/catalog.json") },
  });
  if (args.help) {
    audit.print(
      `Usage: node scripts/generate-api-catalog.mjs (--download | --source PATH | --cached-source PATH) [--cache PATH] [--inventory PATH] [--output PATH] [--check]\nSource: Mattermost v${audit.VERSION}, commit ${audit.COMMIT}. Run audit-api-coverage.mjs first. --check verifies immutable source, current inventory and catalog.`,
    );
    return;
  }
  const files = await audit.loadSource(args);
  const extra = await supplementalSource(
    args.source ?? args["cached-source"] ?? args.cache,
    !!args.download,
    !!args.source,
  );
  const inventory = audit.buildInventory(files);
  if (!isDeepStrictEqual(audit.readJson(args.inventory), inventory)) {
    throw new Error(
      "Inventory differs from pinned source/current tool mapping; regenerate audit-api-coverage.mjs first",
    );
  }
  const catalog = buildCatalog(files, inventory, extra);
  if (args.check) {
    if (!isDeepStrictEqual(audit.readJson(args.output), catalog))
      throw new Error(`Catalog differs: ${args.output}`);
    audit.print("Catalog matches immutable source, current inventory and explicit corrections.");
  } else audit.writeJson(args.output, catalog);
  audit.print(
    JSON.stringify({
      operations: Object.keys(catalog.operations).length,
      account_callable: inventory.counts.generic_callable_routes,
      schemas: Object.keys(catalog.components.schemas).length,
      correction_groups: catalog.corrections.length,
    }),
  );
}

if (audit.isMain(import.meta.url)) {
  main().catch((error) => {
    console.error(`catalog generation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
