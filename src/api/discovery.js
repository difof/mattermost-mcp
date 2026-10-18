import { readFileSync } from "node:fs";
import { GuardrailError } from "../guardrails.js";
import { operationGuard } from "./policy.js";

// Generated data stays outside the MCP tool input schemas.
export const apiCatalog = JSON.parse(
  readFileSync(new URL("./catalog.json", import.meta.url), "utf8"),
);
const operations = Object.entries(apiCatalog.operations).map(([operation, definition]) => ({
  ...definition,
  operation,
}));
operations.sort((a, b) => a.operation.localeCompare(b.operation, "en"));

export function isAvailable(operation) {
  return operation.transport === "http" && ["session", "public"].includes(operation.auth);
}

export function resolveOperation(id) {
  const exact = operations.find((operation) => operation.operation === id);
  if (exact) return exact;
  const aliases = operations.filter((operation) => operation.operationId === id);
  if (aliases.length === 1) return aliases[0];
  if (aliases.length > 1) {
    throw new GuardrailError(
      `ambiguous operation '${id}'; use the METHOD /api/v4/path identifier from api_search`,
    );
  }
  throw new GuardrailError(
    `unknown operation '${id}'; use api_search to find a registered operation`,
  );
}

export function searchOperations({ query = "", limit = 10, offset = 0 } = {}) {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches = operations.filter((operation) => {
    const haystack = [
      operation.operation,
      operation.operationId,
      operation.summary,
      operation.description,
      ...(operation.tags ?? []),
    ]
      .join(" ")
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
  return {
    total: matches.length,
    offset,
    operations: matches.slice(offset, offset + limit).map((operation) => ({
      operation: operation.operation,
      summary: operation.summary,
      method: operation.method,
      path: operation.path,
      auth: operation.auth,
      available: isAvailable(operation),
      ...operationGuard(operation),
    })),
    ...(offset + limit < matches.length ? { next_offset: offset + limit } : {}),
  };
}

// Include only definitions referenced by this request (and optional response).
// Recursive schemas remain references; no expansive per-endpoint type copies.
function referencedComponents(document) {
  const components = {};
  const visited = new Set();
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (typeof value.$ref === "string" && value.$ref.startsWith("#/components/")) {
      const [, , section, encodedName] = value.$ref.split("/");
      const name = encodedName?.replace(/~1/g, "/").replace(/~0/g, "~");
      const key = `${section}/${name}`;
      if (!visited.has(key)) {
        visited.add(key);
        const definition = apiCatalog.components?.[section]?.[name];
        if (definition === undefined)
          throw new Error(`catalog contains an unresolved reference: ${value.$ref}`);
        components[section] ??= {};
        components[section][name] = definition;
        visit(definition);
      }
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(document);
  return components;
}

export function describeOperation({ operation, include_response = false }) {
  const definition = resolveOperation(operation);
  const { responses, ...request } = definition;
  const description = {
    ...request,
    available: isAvailable(definition),
    policy: operationGuard(definition),
    response_statuses: Object.keys(responses ?? {}),
    ...(include_response ? { responses } : {}),
  };
  return { ...description, components: referencedComponents(description) };
}
