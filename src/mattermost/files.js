// File routes absent from Client4 use its auth, timeout and request retry policy.
import { runClientRequest } from "./resilience.js";
import { readApiResponse } from "./http-response.js";

/** Metadata also identifies the post owning a file for resource guard checks. */
export function fetchFileMetadata(client, fileId) {
  const url = `${client.getFileRoute(fileId)}/info`;
  const options = { method: "get", redirect: "manual" };
  return runClientRequest(client, url, options, async () => {
    const response = await fetch(url, client.getOptions(options));
    const bytes = await readApiResponse(client, url, response, 1024 * 1024);
    return JSON.parse(new TextDecoder().decode(bytes));
  });
}

/** Bound decoded file bytes and error bodies before returning MCP content. */
export function fetchFileContent(client, fileId, maxBytes) {
  const url = client.getFileRoute(fileId);
  const options = { method: "get", redirect: "manual" };
  return runClientRequest(client, url, options, async () => {
    const response = await fetch(url, client.getOptions(options));
    return readApiResponse(client, url, response, maxBytes, {
      limitMessage: `file exceeds max_bytes (${maxBytes}); raise max_bytes to download`,
    });
  });
}
