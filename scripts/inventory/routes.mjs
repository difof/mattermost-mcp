// Canonical route keys, deterministic ordering and traversal of upstream OpenAPI fragments.
import { parse as parseYaml } from "yaml";

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
export const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const sortedEntries = (object) => Object.entries(object).sort(([a], [b]) => compare(a, b));
export const sortedObject = (object) => Object.fromEntries(sortedEntries(object));
export const uniqueSorted = (values) => [...new Set(values)].sort();
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

export function* documentedOperations(specs) {
  for (const [filename, spec] of Object.entries(specs)) {
    for (const [path, item] of Object.entries(spec)) {
      if (!path.startsWith("/")) continue;
      for (const [method, operation] of Object.entries(item)) {
        if (METHODS.has(method.toUpperCase())) {
          yield { key: routeKey(method, path), filename, item, operation };
        }
      }
    }
  }
}

function documentEvidence(filename, operation) {
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
  return record;
}

export function documentedRoutes(specs) {
  const docs = {};
  for (const { key, filename, operation } of documentedOperations(specs)) {
    if (Object.hasOwn(docs, key)) throw new Error(`Duplicate OpenAPI route: ${key}`);
    docs[key] = documentEvidence(filename, operation);
  }
  return docs;
}
