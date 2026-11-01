// Normalize OpenAPI operations into the compact catalog and validate references.
import { isDeepStrictEqual } from "node:util";
import { VERSION, sourceHashes } from "./mattermost-source.mjs";
import { documentedOperations, sortedObject, uniqueSorted } from "./inventory/routes.mjs";
import { authenticationFamily } from "./inventory/server-routes.mjs";
import { applyCatalogCorrections } from "./api-catalog-corrections.mjs";

function documentsByRoute(specs) {
  const docs = {};
  for (const { key, item, operation } of documentedOperations(specs)) {
    const document = structuredClone(operation);
    document.parameters = [
      ...structuredClone(item.parameters ?? []),
      ...(document.parameters ?? []),
    ];
    docs[key] = document;
  }
  return docs;
}

function normalizeOperation(key, record, document, corrections) {
  const [method, path] = key.split(" ", 2);
  const server = record.local_socket_only ?? record;
  const wrapper = server.auth_wrapper;
  const auth = authenticationFamily(wrapper);
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
  const missing = addPathParameters(operation);
  if (missing.length && Object.keys(document).length) {
    corrections.push({
      operations: [key],
      reason: `Declare missing required path parameter(s): ${missing.join(", ")}.`,
      sources: [server.server],
    });
  }
  return operation;
}

function addPathParameters(operation) {
  const { path } = operation;
  const names = new Set(operation.parameters.filter((p) => p.in === "path").map((p) => p.name));
  const missing = [...path.matchAll(/\{([^{}]+)\}/g)]
    .map((match) => match[1])
    .filter((name) => !names.has(name));
  for (const name of missing)
    operation.parameters.push({ name, in: "path", required: true, schema: { type: "string" } });
  return missing;
}

export function buildCatalog(specs, inventory, extra) {
  const definitions = specs["api/v4/source/definitions.yaml"].components;
  const components = structuredClone({
    schemas: definitions.schemas,
    responses: definitions.responses,
  });
  const documents = documentsByRoute(specs);
  const operations = {};
  const corrections = [];
  for (const [key, record] of Object.entries(inventory.routes)) {
    operations[key] = normalizeOperation(key, record, documents[key] ?? {}, corrections);
  }
  applyCatalogCorrections(operations, components, inventory, corrections);
  const catalog = {
    version: VERSION,
    source: {
      ...inventory.source,
      supplemental_source_sha256: sourceHashes(extra),
      scope:
        "601 inventoried core REST operations: 590 session/public HTTP, 6 special-auth HTTP, 5 documented local-socket operations. No plugin, WebSocket, /api/v5 or root routes.",
      authentication:
        "auth is the route wrapper's credential family, not an evaluated permission grant. Public wrappers may require endpoint-specific credentials. Handler checks, account roles, membership, MFA, licenses, server settings and feature flags remain authoritative.",
      schema_limitations:
        "OpenAPI plus explicit source-backed corrections; not an exhaustive schema for every server-accepted field or deployment response. Undocumented body/query fields may be needed. References are preserved for lazy transitive schema discovery.",
    },
    operations: sortedObject(operations),
    components,
    corrections,
  };
  validateCatalog(catalog, inventory);
  return catalog;
}

function checkReference(catalog, reference) {
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

function checkReferences(catalog) {
  function visit(value) {
    if (value === null || typeof value !== "object") return;
    if (Object.hasOwn(value, "$ref")) checkReference(catalog, value.$ref);
    for (const child of Object.values(value)) visit(child);
  }
  visit(catalog);
}

function validateCatalog(catalog, inventory) {
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
  checkReferences(catalog);
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
