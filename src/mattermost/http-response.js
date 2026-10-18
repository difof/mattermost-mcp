import mattermost from "@mattermost/client";
import { Buffer } from "node:buffer";

class ResponseLimitError extends Error {}

async function cancel(stream) {
  try {
    await stream?.cancel();
  } catch {
    // Preserve the size failure if cancellation races a disconnect.
  }
}

/** Bound decoded bytes, including chunked and compressed responses. */
export async function readBounded(response, maxBytes, limitMessage) {
  // HEAD/204/304 can advertise a representation's size without a body.
  if (!response.body) return Buffer.alloc(0);
  const tooLarge = () =>
    new ResponseLimitError(
      limitMessage ??
        `response exceeds max_bytes (${maxBytes}); request a smaller page or increase max_bytes`,
    );
  const length = response.headers.get("content-length");
  const encoding = response.headers.get("content-encoding");
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

function apiError(client, url, response, body, fallback) {
  let detail;
  try {
    detail = JSON.parse(body);
  } catch {
    // Proxies can return text or HTML instead of a Mattermost error object.
  }
  return new mattermost.ClientError(client.getUrl(), {
    url,
    status_code: response.status,
    message: typeof detail?.message === "string" ? detail.message : body || fallback,
    ...(typeof detail?.id === "string" ? { server_error_id: detail.id } : {}),
    ...(typeof detail?.detailed_error === "string"
      ? { detailed_error: detail.detailed_error }
      : {}),
  });
}

/** Keep HTTP failures identifiable even when reading their response body fails. */
export async function readApiResponse(
  client,
  url,
  response,
  maxBytes,
  { allowRedirect = false, limitMessage } = {},
) {
  const success = response.ok || (allowRedirect && response.status >= 300 && response.status < 400);
  let bytes;
  try {
    bytes = await readBounded(response, maxBytes, limitMessage);
  } catch (error) {
    if (!success && error instanceof ResponseLimitError) {
      // Size failures are deterministic: retain status without retrying an
      // oversized 429/5xx response or refreshing credentials to read it again.
      throw new Error(`Mattermost API error ${response.status}: ${error.message}`);
    }
    if (!success) throw apiError(client, url, response, "", error.message);
    throw error;
  }
  if (!success) {
    throw apiError(client, url, response, new TextDecoder().decode(bytes), response.statusText);
  }
  return bytes;
}
