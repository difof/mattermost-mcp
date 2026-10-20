import { Blob } from "node:buffer";
import { createUploadReader } from "../mattermost/uploads.js";

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
  // Reject malformed headers before opening a local upload source.
  const normalized = new Headers(headers);
  for (const name of Object.keys(headers)) headers[name] = normalized.get(name);
  return headers;
}

async function requestBody(operation, args, headers, uploads) {
  const hasBody = Object.hasOwn(args, "body");
  const hasBase64 = args.body_base64 !== undefined;
  const hasFile = args.body_file_path !== undefined;
  const hasBytes = hasBase64 || hasFile;
  if (hasBase64 && hasFile)
    throw new Error("body_base64 and body_file_path are mutually exclusive");
  if (hasBytes && (hasBody || args.files))
    throw new Error("body_base64/body_file_path are mutually exclusive with body and files");
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
  const contentType = new Headers({ "Content-Type": args.content_type ?? preferred }).get(
    "content-type",
  );
  const media = contentType.split(";")[0].trim().toLowerCase();
  if (!allowed.map((type) => type.toLowerCase()).includes(media)) {
    throw new Error(
      `content_type '${media}' is not supported for this operation; use api_describe`,
    );
  }
  if (media === "multipart/form-data") {
    if (hasBytes) throw new Error("multipart uploads use files, not body_base64/body_file_path");
    if (
      hasBody &&
      (args.body === null || typeof args.body !== "object" || Array.isArray(args.body))
    ) {
      throw new Error("multipart body must be an object of form fields");
    }
    const form = new FormData();
    const readUpload = createUploadReader(uploads);
    for (const [field, value] of Object.entries(args.body ?? {})) {
      for (const item of Array.isArray(value) ? value : [value]) {
        form.append(
          field,
          item !== null && typeof item === "object" ? JSON.stringify(item) : String(item),
        );
      }
    }
    for (const file of args.files ?? []) {
      const { bytes, filename } = await readUpload(file);
      form.append(
        file.field,
        new Blob([bytes], {
          type: file.content_type ?? "application/octet-stream",
        }),
        filename,
      );
    }
    // fetch must generate the boundary; a caller-provided boundary is never used.
    return form;
  }
  if (args.files) throw new Error("files requires multipart/form-data");
  // Match Client4's spelling so its JSON default is replaced, not duplicated.
  headers["Content-Type"] = contentType;
  if (media === "application/json" || media.endsWith("+json")) {
    if (hasBytes) throw new Error("JSON requests use body, not body_base64/body_file_path");
    return JSON.stringify(args.body);
  }
  if (!hasBytes) throw new Error("binary requests require body_base64 or body_file_path");
  const { bytes } = await createUploadReader(uploads)({
    content_base64: args.body_base64,
    file_path: args.body_file_path,
  });
  return bytes;
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
