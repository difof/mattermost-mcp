import { ResourceGuard } from "../resource-guardrails.js";
import { isMattermostId, allowedChannelTypes } from "./filter.js";
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

/** Current joined channels, including archived memberships when still visible to this account. */
export async function listAccessibleChannels(session, signal = new AbortController().signal) {
  const url = new URL(session.client.getUserRoute("me") + "/channels");
  url.searchParams.set("include_deleted", "true");
  const rows = await readEventJson(session, url, signal);
  if (!Array.isArray(rows)) throw new Error("Invalid channel memberships");
  const guard = new ResourceGuard(session),
    channels = new Map();
  for (const channel of rows) {
    if (!isMattermostId(channel?.id) || !allowedChannelTypes.has(channel.type))
      throw new Error("Invalid channel membership");
    if (await guard.channelAllowed(channel.id, channel)) {
      channels.set(channel.id, {
        id: channel.id,
        type: channel.type,
        last_post_at: channel.last_post_at,
      });
    }
  }
  return channels;
}
