import { readApiResponse, setResponseCeiling, responseCeiling } from "./http-response.js";

// Client4 supplies route methods, headers and token handling. Its default
// transport follows redirects and buffers JSON before any size check.
export function installSdkTransport(client, maxBytes) {
  setResponseCeiling(client, maxBytes);
  client.doFetchWithResponse = async (url, options) => {
    const response = await fetch(url, { ...client.getOptions(options), redirect: "error" });
    const bytes = await readApiResponse(client, url, response, responseCeiling(client), {
      limitMessage: "Mattermost response exceeds MM_MAX_RESPONSE_BYTES",
    });
    const headers = response.headers;
    const text = bytes.toString("utf8");
    const media = headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    let data = text;
    try {
      if (media === "application/json" || media?.endsWith("+json"))
        data = text.length ? JSON.parse(text) : null;
      else if (media === "application/x-ndjson")
        data = text
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line));
    } catch {
      throw new Error("Received invalid JSON from Mattermost");
    }
    return { response, headers, data };
  };
}
