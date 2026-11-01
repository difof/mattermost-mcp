// Extract literal HTTP registrations and authorization evidence from the pinned Go server.
import { METHODS, routeKey, sortedEntries, uniqueSorted } from "./routes.mjs";
const GO_STRING = '(?:"(?:[^"\\\\]|\\\\.)*"|`[^`]*`)';

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

const goString = (literal) =>
  literal.startsWith("`") ? literal.slice(1, -1) : JSON.parse(literal);

function goFunctions(text) {
  const declarations = [...text.matchAll(/^func\s+(?:\([^\n]*?\)\s+)?(\w+)\s*\(/gm)];
  return declarations.map((match, index) => [
    match[1],
    text.slice(match.index, declarations[index + 1]?.index ?? text.length),
    match.index,
  ]);
}

function routePrefixes(files) {
  const init = goFunctions(files["server/channels/api4/api.go"].toString("utf8")).find(
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
  return prefixes;
}

const registration = new RegExp(
  `api\\.BaseRoutes\\.(\\w+)\\.Handle\\((${GO_STRING}),\\s*(.*?)\\)\\.Methods\\(([^)]*)\\)`,
  "gs",
);

function registrationsIn(body, filename, name) {
  if (!body.includes("api.BaseRoutes.") || !body.includes(".Handle(")) return [];
  if (!name.startsWith("Init") && !name.startsWith("init")) {
    throw new Error(`Review unexpected registration function: ${filename}:${name}`);
  }
  const matches = [...body.matchAll(registration)];
  if (matches.length !== [...body.matchAll(/api\.BaseRoutes\.\w+\.Handle\(/g)].length) {
    throw new Error(`Unparsed registration: ${filename}:${name}`);
  }
  return matches;
}

function registrationMethods(text, filename) {
  // Only literal methods are auditable; never keep one method and silently drop a dynamic sibling.
  const tokens = text.trim().replace(/,$/, "").split(",");
  return tokens.map((token) => {
    const parts = /^(?:http\.Method(\w+)|"([A-Z]+)")$/.exec(token.trim());
    const method = (parts?.[1] ?? parts?.[2])?.toUpperCase();
    if (!METHODS.has(method)) throw new Error(`Unparsed methods: ${filename}:${text}`);
    return method;
  });
}

function decodeRegistration(match, prefixes, filename) {
  if (!Object.hasOwn(prefixes, match[1])) throw new Error(`Unknown route prefix: ${match[1]}`);
  const rawPath = prefixes[match[1]] + goString(match[2]);
  const wrappers = [
    ...match[3].matchAll(
      /api\.(API\w+|CloudAPIKeyRequired|RemoteClusterTokenRequired)\((\w+(?:\.\w+)?)/g,
    ),
  ];
  if (wrappers.length !== 1)
    throw new Error(`Review authentication wrapper: ${filename}:${match[0]}`);
  const [, wrapper, handler] = wrappers[0];
  const methods = registrationMethods(match[4], filename);
  const paths = rawPath.includes("{syncable_type:teams|channels}")
    ? ["teams", "channels"].map((kind) => rawPath.replace("{syncable_type:teams|channels}", kind))
    : [rawPath];
  const routes = paths.flatMap((variant) => {
    const path = variant.replace(/\{(\w+):[^{}]*\}/g, "{$1}");
    return methods.map((method) => ({ key: routeKey(method, path), path }));
  });
  return { routes, wrapper, handler };
}

function addHandlerEvidence(record, handlerBody, name, body) {
  const handler = record.handler;
  const permissions = [...handlerBody.matchAll(/model\.(Permission\w+)/g)].map((value) => value[1]);
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
}

function recordRegistration(inventory, registration, location) {
  const { wrapper, handler } = registration;
  const { local, routes, excluded } = inventory;
  const { server, isLocal, bodies, name, body } = location;
  for (const { key, path } of registration.routes) {
    const record = { server, handler, auth_wrapper: wrapper };
    if (isLocal) {
      local[key] = record;
    } else if (!path.startsWith("/api/v4/") || handler === "connectWebSocket") {
      excluded.push({
        route: key,
        ...record,
        reason: handler === "connectWebSocket" ? "websocket" : "outside_v4",
      });
    } else {
      if (Object.hasOwn(routes, key)) throw new Error(`Duplicate server route: ${key}`);
      addHandlerEvidence(record, bodies[handler] ?? "", name, body);
      routes[key] = record;
    }
  }
}

export function registeredRoutes(files) {
  const prefixes = routePrefixes(files);
  const inventory = { routes: {}, excluded: [], local: {} };
  for (const [filename, data] of sortedEntries(files)) {
    if (!filename.endsWith(".go")) continue;
    const text = data.toString("utf8");
    const declared = goFunctions(text);
    const bodies = Object.fromEntries(declared.map(([name, body]) => [name, body]));
    for (const [name, body, offset] of declared) {
      for (const match of registrationsIn(body, filename, name)) {
        const parsed = decodeRegistration(match, prefixes, filename);
        const line = text.slice(0, offset + match.index).split("\n").length;
        recordRegistration(inventory, parsed, {
          bodies,
          name,
          body,
          server: `${filename}:${line}`,
          isLocal: name.includes("Local") || filename.endsWith("_local.go"),
        });
      }
    }
  }
  return inventory;
}
