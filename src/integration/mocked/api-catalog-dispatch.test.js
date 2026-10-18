import { readFileSync } from "node:fs";
import { Blob } from "node:buffer";
import { describe, expect, it } from "vitest";
import { useMattermost } from "./mattermost-http-fixture.ts";

const catalog = JSON.parse(
  readFileSync(new URL("../../api/catalog.json", import.meta.url), "utf8"),
);
const inventory = JSON.parse(
  readFileSync(new URL("../../../docs/api-coverage.json", import.meta.url), "utf8"),
);
const routeIds = Object.keys(inventory.routes).sort();
const METHODS = ["DELETE", "GET", "HEAD", "PATCH", "POST", "PUT"];

// Coverage is selected from the independently audited route inventory, not from
// the runtime's resolver or availability/policy implementation. Catalog schemas
// supply structural inputs only: this sweep does not simulate server validation,
// account permissions, licensing or feature flags. Curated contracts live next door.
function inventoryAuth(route) {
  if (route.local_socket_only) return "local";
  if (route.auth_wrapper === "CloudAPIKeyRequired") return "cloud";
  if (route.auth_wrapper === "RemoteClusterTokenRequired") return "remote_cluster";
  if (route.auth_wrapper?.startsWith("APISessionRequired")) return "session";
  if (route.auth_wrapper?.startsWith("APIHandler")) return "public";
  throw new Error(`Unclassified inventory authentication: ${route.auth_wrapper}`);
}

const httpRoutes = routeIds.filter((id) =>
  ["session", "public"].includes(inventoryAuth(inventory.routes[id])),
);
const blockedRoutes = routeIds.filter((id) => !httpRoutes.includes(id));

function reference(document, ref) {
  expect(ref).toMatch(/^#\/components\/(schemas|responses)\//);
  return ref
    .slice(2)
    .split("/")
    .reduce((value, key) => value?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], document);
}

function schemaValue(schema = {}, depth = 0) {
  if (depth > 8) throw new Error("A generated required schema is recursively unbounded");
  if (schema.$ref) return schemaValue(reference(catalog, schema.$ref), depth + 1);
  if (schema.enum?.length) return schema.enum[0];
  if (schema.default !== undefined) return schema.default;
  if (schema.oneOf || schema.anyOf)
    return schemaValue((schema.oneOf ?? schema.anyOf)[0], depth + 1);
  if (schema.allOf)
    return Object.assign({}, ...schema.allOf.map((part) => schemaValue(part, depth + 1)));
  if (schema.type === "array")
    return Array.from({ length: schema.minItems ?? 1 }, () => schemaValue(schema.items, depth + 1));
  if (schema.type === "object" || schema.properties) {
    return Object.fromEntries(
      (schema.required ?? []).map((name) => [
        name,
        schemaValue(schema.properties?.[name], depth + 1),
      ]),
    );
  }
  if (schema.type === "boolean") return false;
  if (schema.type === "integer" || schema.type === "number") return schema.minimum ?? 0;
  if (schema.format === "date-time") return "2030-01-02T03:04:05Z";
  if (schema.format === "email") return "fixture@example.invalid";
  return "a".repeat(Math.max(schema.minLength ?? 1, Math.min(schema.maxLength ?? 26, 26)));
}

function resolveSchema(schema = {}) {
  return schema.$ref ? resolveSchema(reference(catalog, schema.$ref)) : schema;
}

function generatedRequest(operation) {
  const args = { path: {}, query: {}, headers: {} };
  const exchange = { query: args.query };
  for (const parameter of operation.parameters) {
    if (parameter.in === "path") args.path[parameter.name] = schemaValue(parameter.schema);
    else if (parameter.required && parameter.in === "query")
      args.query[parameter.name] = schemaValue(parameter.schema);
    else if (parameter.required && parameter.in === "header")
      args.headers[parameter.name] = String(schemaValue(parameter.schema));
  }
  const media = operation.requestBody?.content;
  if (!media || ["GET", "HEAD"].includes(operation.method)) return { args, exchange };
  const contentType = ["application/json", "multipart/form-data", "application/octet-stream"].find(
    (type) => media[type],
  );
  expect(
    contentType,
    `Unhandled request encoding: ${operation.method} ${operation.path}`,
  ).toBeTruthy();
  args.content_type = contentType;
  const schema = resolveSchema(media[contentType].schema);
  if (contentType === "application/json") {
    args.body = schemaValue(schema);
    exchange.body = args.body;
  } else if (contentType === "application/octet-stream") {
    const bytes = Buffer.from([0, 255, 65]);
    args.body_base64 = bytes.toString("base64");
    exchange.inspectBody = (body) => expect(body).toEqual(bytes);
  } else {
    const fields = Object.entries(schema.properties ?? {});
    const binaryFields = fields.filter(([, field]) => resolveSchema(field).format === "binary");
    const body = schemaValue(schema);
    args.body = Object.fromEntries(
      Object.entries(body).filter(([name]) => !binaryFields.some(([field]) => field === name)),
    );
    if (binaryFields.length) {
      args.files = binaryFields.map(([field]) => ({
        field,
        filename: "fixture.bin",
        content_base64: "AP9B",
      }));
    }
    exchange.inspectBody = async (bytes, headers) => {
      expect(headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
      const form = await new globalThis.Response(bytes, {
        headers: { "Content-Type": headers["content-type"] },
      }).formData();
      const textFields = Object.entries(args.body).flatMap(([name, values]) =>
        (Array.isArray(values) ? values : [values]).map((value) => [
          name,
          value !== null && typeof value === "object" ? JSON.stringify(value) : String(value),
        ]),
      );
      expect([...form.keys()].sort()).toEqual(
        [...textFields.map(([name]) => name), ...binaryFields.map(([name]) => name)].sort(),
      );
      for (const [name, value] of textFields) expect(form.getAll(name)).toContain(value);
      for (const [name] of binaryFields) {
        const file = form.get(name);
        expect(file).toBeInstanceOf(Blob);
        expect(file.name).toBe("fixture.bin");
        expect(Buffer.from(await file.arrayBuffer())).toEqual(Buffer.from([0, 255, 65]));
      }
    };
  }
  return { args, exchange };
}

// Check both dangling refs and accidental inclusion of the whole schema catalog.
// Traverse as a work queue to keep reference cycles finite.
function assertReferenceClosure(description) {
  const { components, ...operation } = description;
  const queue = [operation];
  const reached = new Set();
  while (queue.length) {
    const value = queue.pop();
    if (!value || typeof value !== "object") continue;
    if (value.$ref && !reached.has(value.$ref)) {
      reached.add(value.$ref);
      const target = reference(description, value.$ref);
      expect(target, `Unresolved ${value.$ref} in ${description.operation}`).toBeDefined();
      queue.push(target);
    }
    queue.push(...Object.values(value));
  }
  const included = Object.entries(components).flatMap(([section, values]) =>
    Object.keys(values).map(
      (name) => `#/components/${section}/${name.replace(/~/g, "~0").replace(/\//g, "~1")}`,
    ),
  );
  expect(included.sort(), description.operation).toEqual([...reached].sort());
}

describe("complete pinned API catalog dispatch through MCP and HTTP", () => {
  const fixture = useMattermost({ guardrails: { allowDestructive: true } });

  it("matches every independently inventoried route and its authentication boundary", () => {
    expect(catalog.version).toBe("11.11.1");
    expect(catalog.source.commit).toBe("3acb3a7f684d11ccfcec4e5bd11c79f64e3eabf9");
    expect(catalog.source.commit).toBe(inventory.source.commit);
    expect(routeIds).toHaveLength(601);
    expect(Object.keys(catalog.operations).sort()).toEqual(routeIds);
    expect(httpRoutes).toHaveLength(590);
    expect(blockedRoutes).toHaveLength(11);
    expect([...new Set(routeIds.map((id) => id.split(" ")[0]))].sort()).toEqual(METHODS);
    for (const id of routeIds) {
      const operation = catalog.operations[id];
      expect(`${operation.method} ${operation.path}`, id).toBe(id);
      expect(operation.auth, id).toBe(inventoryAuth(inventory.routes[id]));
      expect(operation.transport, id).toBe(operation.auth === "local" ? "local" : "http");
      const parameters = operation.parameters
        .filter((parameter) => parameter.in === "path")
        .map((parameter) => parameter.name);
      const placeholders = [...id.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]);
      expect(parameters.sort(), id).toEqual([...new Set(placeholders)].sort());
    }
  });

  it.each(METHODS)(
    "dispatches every HTTP-callable %s operation using the audited path",
    async (method) => {
      const mm = fixture();
      const routes = httpRoutes.filter((id) => id.startsWith(`${method} `));
      expect(routes.length).toBeGreaterThan(0);
      for (const id of routes) {
        const operation = catalog.operations[id];
        const { args, exchange } = generatedRequest(operation);
        // Render the expected route from the independent inventory key, not a
        // production URL helper or catalog-provided HTTP path.
        const suffix = id
          .slice(`${method} /api/v4`.length)
          .split("/")
          .map((part) =>
            part.startsWith("{") ? encodeURIComponent(String(args.path[part.slice(1, -1)])) : part,
          )
          .join("/");
        const reply = { mock_dispatch: id };
        mm.expect(method, suffix, {
          ...exchange,
          reply,
          headers: { "X-Request-Id": id },
          fetchRedirect: "manual",
        });
        const result = await mm.call("api_call", { operation: id, ...args, confirm: true });
        expect(result, id).toMatchObject({
          status: 200,
          headers: { "x-request-id": id },
          data: method === "HEAD" ? null : reply,
        });
      }
    },
    20000,
  );

  it("refuses all six special-auth and five local-socket operations before HTTP", async () => {
    const mm = fixture();
    const counts = { local: 0, cloud: 0, remote_cluster: 0 };
    for (const id of blockedRoutes) {
      const auth = inventoryAuth(inventory.routes[id]);
      counts[auth] += 1;
      const error = await mm.error("api_call", { operation: id, confirm: true });
      expect(error, id).toContain(auth === "local" ? "local socket" : auth);
    }
    expect(counts).toEqual({ local: 5, cloud: 1, remote_cluster: 5 });
  });

  it("paginates bounded discovery without omissions, duplicates, or HTTP", async () => {
    const mm = fixture();
    const first = await mm.call("api_search");
    expect(first).toMatchObject({ total: 601, offset: 0, next_offset: 10 });
    expect(first.operations).toHaveLength(10);
    const discovered = [];
    for (let offset = 0; offset < first.total; offset += 50) {
      const page = await mm.call("api_search", { offset, limit: 50 });
      expect(page.offset).toBe(offset);
      expect(page.operations.length).toBeLessThanOrEqual(50);
      expect(page.next_offset).toBe(offset + 50 < first.total ? offset + 50 : undefined);
      discovered.push(...page.operations);
    }
    expect(discovered.map(({ operation }) => operation).sort()).toEqual(routeIds);
    expect(first.operations).toEqual(discovered.slice(0, 10));
    for (const operation of discovered) {
      expect(operation.auth).toBe(inventoryAuth(inventory.routes[operation.operation]));
      expect(operation.available).toBe(httpRoutes.includes(operation.operation));
      expect(operation).not.toHaveProperty("requestBody");
    }
    expect(await mm.call("api_search", { offset: 1000 })).toEqual({
      total: 601,
      offset: 1000,
      operations: [],
    });
    const match = await mm.call("api_search", { query: "PoSt /api/v4/channels/direct" });
    expect(
      match.operations.some(({ operation }) => operation === "POST /api/v4/channels/direct"),
    ).toBe(true);
    expect(await mm.call("api_search", { query: "not-a-mattermost-operation-987654" })).toEqual({
      total: 0,
      offset: 0,
      operations: [],
    });
    for (const args of [{ limit: 0 }, { limit: 51 }, { offset: -1 }, { query: "x".repeat(501) }]) {
      expect(await mm.error("api_search", args)).toContain("invalid arguments");
    }
  });

  it("describes only requested schemas and resolves unique aliases without accepting ambiguous ones", async () => {
    const mm = fixture();
    const basic = await mm.call("api_describe", { operation: "POST /api/v4/drafts" });
    expect(basic).not.toHaveProperty("responses");
    expect(basic.components.schemas).toHaveProperty("DraftUpsertRequest");
    expect(basic.components.schemas).not.toHaveProperty("Draft");
    assertReferenceClosure(basic);
    const expanded = await mm.call("api_describe", {
      operation: "UpsertDraft",
      include_response: true,
    });
    expect(expanded).toMatchObject({
      operation: "POST /api/v4/drafts",
      available: true,
      policy: { write: true, destructive: false },
    });
    expect(expanded.components.schemas).toHaveProperty("Draft");
    expect(expanded.responses).toHaveProperty("201");
    assertReferenceClosure(expanded);
    mm.expect("GET", "/posts/" + "a".repeat(26), { reply: { id: "a".repeat(26) } });
    expect(
      await mm.call("api_call", { operation: "GetPost", path: { post_id: "a".repeat(26) } }),
    ).toMatchObject({ data: { id: "a".repeat(26) } });
    for (const tool of ["api_describe", "api_call"]) {
      expect(await mm.error(tool, { operation: "SearchFiles" })).toContain("ambiguous");
    }
  });

  it("describes all 601 operations with a closed, minimal set of transitive schema references", async () => {
    const mm = fixture();
    for (const operation of routeIds) {
      const description = await mm.call("api_describe", { operation, include_response: true });
      expect(description.operation).toBe(operation);
      expect(description.responses).toBeDefined();
      assertReferenceClosure(description);
    }
  }, 20000);
});
