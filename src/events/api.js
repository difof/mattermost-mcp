import { runClientRequest } from "../mattermost/resilience.js";
import { readApiResponse } from "../mattermost/http-response.js";

// All event reconciliation requests are bounded, cancellable GETs on routes constructed
// by Client4, with the same token/recovery policy and no credential-bearing redirects.
export function readEventJson(session, url, signal) {
  const { client } = session;
  const options = { method: "get", redirect: "manual", signal };
  return runClientRequest(client, String(url), options, async () => {
    signal.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort();
    const deadline = setTimeout(abort, session.config.resilience?.timeoutMs || 30_000);
    signal.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetch(
        url,
        client.getOptions({ ...options, signal: controller.signal }),
      );
      const bytes = await readApiResponse(client, String(url), response, 8 * 1024 * 1024);
      return JSON.parse(bytes.toString("utf8"));
    } finally {
      clearTimeout(deadline);
      signal.removeEventListener("abort", abort);
    }
  });
}
