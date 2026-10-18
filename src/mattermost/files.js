// File routes absent from Client4's public methods share its request options,
// authentication recovery, and retry policy through this bounded transport.
import mattermost from "@mattermost/client";
import { runClientRequest } from "./resilience.js";
async function assertResponseOk(client, url, response) {
  if (response.ok) return;
  const body = await response.text();
  let error = {};
  try {
    const parsed = JSON.parse(body);
    if (parsed !== null && typeof parsed === "object") {
      error = parsed;
    }
  } catch {
    // Reverse proxies can return plain text or HTML instead of an API error.
  }
  throw new mattermost.ClientError(client.getUrl(), {
    url,
    status_code: response.status,
    message: typeof error.message === "string" ? error.message : body || response.statusText,
    ...(typeof error.id === "string" ? { server_error_id: error.id } : {}),
    ...(typeof error.detailed_error === "string" ? { detailed_error: error.detailed_error } : {}),
  });
}
/** Metadata also identifies the post owning a file for resource guard checks. */
export function fetchFileMetadata(client, fileId) {
  const url = `${client.getFileRoute(fileId)}/info`;
  const options = { method: "get" };
  return runClientRequest(client, url, options, async () => {
    const response = await fetch(url, client.getOptions(options));
    await assertResponseOk(client, url, response);
    return await response.json();
  });
}
function sizeError(maxBytes) {
  return new Error(`file exceeds max_bytes (${maxBytes}); raise max_bytes to download`);
}
async function cancelOversizedDownload(stream) {
  try {
    await stream?.cancel();
  } catch {
    // A disconnected stream can reject cancellation. Preserve the size failure
    // so it cannot be mistaken for a transient error and retried.
  }
}
/** Stop downloading as soon as a response exceeds the accepted decoded size. */
export function fetchFileContent(client, fileId, maxBytes) {
  const url = client.getFileRoute(fileId);
  const options = { method: "get" };
  return runClientRequest(client, url, options, async () => {
    const response = await fetch(url, client.getOptions(options));
    await assertResponseOk(client, url, response);
    const contentLength = response.headers.get("content-length");
    const encoding = response.headers.get("content-encoding");
    // Compressed Content-Length describes transfer bytes, not the decoded file.
    if (
      (!encoding || encoding === "identity") &&
      contentLength &&
      Number(contentLength) > maxBytes
    ) {
      await cancelOversizedDownload(response.body);
      throw sizeError(maxBytes);
    }
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await cancelOversizedDownload(reader);
          throw sizeError(maxBytes);
        }
        chunks.push(value);
      }
      return Buffer.concat(chunks, size);
    } finally {
      reader.releaseLock();
    }
  });
}
