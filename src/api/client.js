import mattermost from "@mattermost/client";
import { Buffer, Blob } from "node:buffer";
import { runClientRequest } from "../mattermost/resilience.js";
import { operationGuard } from "./policy.js";

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
const responseHeaders = new Set([
  "content-type",
  "content-length",
  "content-disposition",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
  "location",
  "link",
  "retry-after",
  "x-request-id",
  "x-version-id",
  "x-total-count",
  "total-count",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
]);

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
  const parameters = operation.parameters ?? [];
  for (const [name, value] of Object.entries(args.query ?? {})) {
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
  return headers;
}

function decodeBase64(value) {
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value)
    throw new Error("binary content must be canonical base64");
  return bytes;
}

function requestBody(operation, args, headers) {
  const hasBody = Object.hasOwn(args, "body");
  const hasBytes = args.body_base64 !== undefined;
  if (hasBytes && (hasBody || args.files))
    throw new Error("body_base64 is mutually exclusive with body and files");
  if (!hasBody && !hasBytes && !args.files) {
    if (args.content_type) throw new Error("content_type requires a request body");
    return undefined;
  }
  if (["GET", "HEAD"].includes(operation.method))
    throw new Error(`${operation.method} operations do not accept a request body`);
  const mediaTypes = Object.keys(operation.requestBody?.content ?? {});
  // Missing body schemas are a known upstream omission; JSON remains usable.
  const allowed = mediaTypes.length ? mediaTypes : ["application/json"];
  const preferred = args.files
    ? "multipart/form-data"
    : hasBytes
      ? "application/octet-stream"
      : allowed.includes("application/json")
        ? "application/json"
        : allowed[0];
  const contentType = args.content_type ?? preferred;
  const media = contentType.split(";")[0].trim().toLowerCase();
  if (!allowed.map((type) => type.toLowerCase()).includes(media)) {
    throw new Error(
      `content_type '${media}' is not supported for this operation; use api_describe`,
    );
  }
  if (media === "multipart/form-data") {
    if (hasBytes) throw new Error("multipart uploads use files, not body_base64");
    if (
      hasBody &&
      (args.body === null || typeof args.body !== "object" || Array.isArray(args.body))
    ) {
      throw new Error("multipart body must be an object of form fields");
    }
    const form = new FormData();
    for (const [field, value] of Object.entries(args.body ?? {})) {
      for (const item of Array.isArray(value) ? value : [value]) {
        form.append(
          field,
          item !== null && typeof item === "object" ? JSON.stringify(item) : String(item),
        );
      }
    }
    for (const file of args.files ?? []) {
      form.append(
        file.field,
        new Blob([decodeBase64(file.content_base64)], {
          type: file.content_type ?? "application/octet-stream",
        }),
        file.filename,
      );
    }
    // fetch must generate the boundary; a caller-provided boundary is never used.
    return form;
  }
  if (args.files) throw new Error("files requires multipart/form-data");
  // Match Client4's spelling so its JSON default is replaced, not duplicated.
  headers["Content-Type"] = contentType;
  if (media === "application/json" || media.endsWith("+json")) {
    if (hasBytes) throw new Error("JSON requests use body, not body_base64");
    return JSON.stringify(args.body);
  }
  if (!hasBytes) throw new Error("binary requests require body_base64");
  return decodeBase64(args.body_base64);
}

async function cancel(stream) {
  try {
    await stream?.cancel();
  } catch {
    /* Keep the size failure if cancellation races a disconnect. */
  }
}

class ResponseLimitError extends Error {}

async function readBounded(response, maxBytes) {
  // HEAD/204/304 can advertise the representation's size without a body.
  if (!response.body) return Buffer.alloc(0);
  const length = response.headers.get("content-length");
  const encoding = response.headers.get("content-encoding");
  const tooLarge = () =>
    new ResponseLimitError(
      `response exceeds max_bytes (${maxBytes}); request a smaller page or increase max_bytes`,
    );
  if ((!encoding || encoding === "identity") && length && Number(length) > maxBytes) {
    await cancel(response.body);
    throw tooLarge();
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await cancel(reader);
        throw tooLarge();
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    reader.releaseLock();
  }
}

function apiError(client, url, status, body, fallback) {
  let detail;
  try {
    detail = JSON.parse(body);
  } catch {
    /* Proxies can return text or HTML. */
  }
  return new mattermost.ClientError(client.getUrl(), {
    url,
    status_code: status,
    message: typeof detail?.message === "string" ? detail.message : body || fallback,
    ...(typeof detail?.id === "string" ? { server_error_id: detail.id } : {}),
    ...(typeof detail?.detailed_error === "string"
      ? { detailed_error: detail.detailed_error }
      : {}),
  });
}

function decodeResponse(operation, args, response, bytes) {
  const headers = Object.fromEntries(
    [...response.headers].filter(([name]) => responseHeaders.has(name.toLowerCase())),
  );
  const envelope = { status: response.status, headers };
  if (response.status === 204 || response.status === 304 || operation.method === "HEAD")
    return { ...envelope, data: null };
  const declared = Object.keys(operation.responses?.[String(response.status)]?.content ?? {});
  const media = (response.headers.get("content-type") ?? declared[0] ?? "text/plain")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const json = media === "application/json" || media.endsWith("+json");
  const ndjson = media === "application/x-ndjson";
  const format = args.response_format ?? "auto";
  if (
    format === "base64" ||
    (format === "auto" &&
      !json &&
      !ndjson &&
      !media.startsWith("text/") &&
      !["application/xml", "application/javascript"].includes(media))
  ) {
    return { ...envelope, body_base64: bytes.toString("base64"), bytes: bytes.length };
  }
  if (!bytes.length) return { ...envelope, data: null };
  const text = bytes.toString("utf8");
  if (format === "text") return { ...envelope, data: text };
  try {
    return {
      ...envelope,
      data:
        format === "json" || json
          ? JSON.parse(text)
          : ndjson
            ? text
                .split(/\r?\n/)
                .filter((line) => line.trim())
                .map((line) => JSON.parse(line))
            : text,
    };
  } catch {
    throw new Error(`invalid JSON response (HTTP ${response.status})`);
  }
}

/** Reuse Client4 auth/options and the session runner, including bounded binary responses. */
export function callApi(client, operation, args) {
  const url = requestUrl(client, operation, args);
  const headers = headersFor(operation, args.headers);
  const body = requestBody(operation, args, headers);
  const options = {
    method: operation.method,
    headers,
    redirect: "manual",
    ...(body !== undefined ? { body } : {}),
  };
  return runClientRequest(
    client,
    url,
    options,
    async () => {
      const response = await fetch(url, client.getOptions(options));
      const success = response.ok || (response.status >= 300 && response.status < 400);
      let bytes;
      try {
        bytes = await readBounded(response, args.max_bytes ?? 1024 * 1024);
      } catch (error) {
        if (!success && error instanceof ResponseLimitError) {
          // Retain the HTTP status without classifying a deterministic limit as a
          // transient 429/5xx response that would download the same oversized body again.
          throw new Error(`Mattermost API error ${response.status}: ${error.message}`);
        }
        if (!success) throw apiError(client, url, response.status, "", error.message);
        throw error;
      }
      if (!success)
        throw apiError(client, url, response.status, bytes.toString("utf8"), response.statusText);
      return decodeResponse(operation, args, response, bytes);
    },
    { retrySafe: !operationGuard(operation).write },
  );
}
