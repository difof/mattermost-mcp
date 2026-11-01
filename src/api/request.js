import { requestBody } from "./request-body.js";

const requestHeaders = new Set([
  "accept",
  "if-none-match",
  "if-modified-since",
  "if-match",
  "if-unmodified-since",
  "range",
  "content-range",
  "connection-id",
]);
const forbiddenHeaders =
  /^(?:authorization|proxy-authorization|cookie|host|content-type|content-length|transfer-encoding|connection|x-forwarded-.*|x-real-ip|x-csrf-token|x-requested-with)$/i;
function encodePathValue(name, value) {
  const text = String(value);
  const control = [...text].some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
  if (!text || text === "." || text === ".." || /[/\\%]/.test(text) || control) {
    throw new Error(`invalid path parameter '${name}'; pass one unencoded path segment`);
  }
  return encodeURIComponent(text);
}

function appendQuery(url, operation, query) {
  const parameters = operation.parameters ?? [];
  for (const [name, value] of Object.entries(query ?? {})) {
    if (name.toLowerCase() === "access_token")
      throw new Error("query access_token cannot override the configured account");
    const parameter = parameters.find(
      (parameter) => parameter.in === "query" && parameter.name === name,
    );
    if (Array.isArray(value)) {
      const separator =
        parameter?.style === "spaceDelimited"
          ? " "
          : parameter?.style === "pipeDelimited"
            ? "|"
            : ",";
      if (
        parameter?.explode === false ||
        ["spaceDelimited", "pipeDelimited"].includes(parameter?.style)
      ) {
        url.searchParams.append(name, value.join(separator));
      } else {
        for (const item of value) url.searchParams.append(name, String(item));
      }
    } else {
      url.searchParams.append(name, String(value));
    }
  }
}

function requestUrl(client, operation, args) {
  const supplied = args.path ?? {};
  const names = [...operation.path.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]);
  for (const name of names) {
    if (!Object.hasOwn(supplied, name)) throw new Error(`missing path parameter '${name}'`);
  }
  for (const name of Object.keys(supplied)) {
    if (!names.includes(name)) throw new Error(`unknown path parameter '${name}'`);
  }
  if (!operation.path.startsWith("/api/v4/"))
    throw new Error("operation is outside the core REST API");
  const suffix = operation.path
    .slice("/api/v4".length)
    .replace(/\{([^{}]+)\}/g, (_, name) => encodePathValue(name, supplied[name]));
  const url = new URL(`${client.getBaseRoute()}${suffix}`);
  appendQuery(url, operation, args.query);
  return url.toString();
}

function headersFor(operation, supplied) {
  const declared = (operation.parameters ?? [])
    .filter((parameter) => parameter.in === "header")
    .map((parameter) => parameter.name.toLowerCase());
  const headers = {};
  for (const [name, value] of Object.entries(supplied ?? {})) {
    const lower = name.toLowerCase();
    if (forbiddenHeaders.test(lower) || (!requestHeaders.has(lower) && !declared.includes(lower))) {
      throw new Error(`header '${name}' cannot be supplied through api_call`);
    }
    if (Object.hasOwn(headers, lower)) throw new Error(`duplicate header '${name}'`);
    headers[lower] = value;
  }
  // Reject malformed headers before opening a local upload source.
  const normalized = new Headers(headers);
  for (const name of Object.keys(headers)) headers[name] = normalized.get(name);
  return headers;
}

export async function createRequest(client, operation, args, uploads) {
  const url = requestUrl(client, operation, args);
  const headers = headersFor(operation, args.headers);
  const body = await requestBody(operation, args, headers, uploads);
  return {
    url,
    options: {
      method: operation.method,
      headers,
      redirect: "manual",
      ...(body !== undefined ? { body } : {}),
    },
  };
}
