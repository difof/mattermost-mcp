import { runClientRequest } from "../mattermost/resilience.js";
import { readApiResponse } from "../mattermost/http-response.js";
import { operationGuard } from "./policy.js";
import { createRequest } from "./request.js";

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
  if (format === "text") return { ...envelope, data: bytes.toString("utf8") };
  const text = new TextDecoder().decode(bytes);
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

/** Use session auth/retries; serialization stays separate from HTTP execution. */
export async function callApi(client, operation, args, uploads) {
  const { url, options } = await createRequest(client, operation, args, uploads);
  return runClientRequest(
    client,
    url,
    options,
    async () => {
      const response = await fetch(url, client.getOptions(options));
      const bytes = await readApiResponse(client, url, response, args.max_bytes ?? 1024 * 1024, {
        allowRedirect: true,
      });
      return decodeResponse(operation, args, response, bytes);
    },
    { retrySafe: !operationGuard(operation).write },
  );
}
