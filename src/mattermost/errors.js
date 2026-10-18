// @mattermost/client is CommonJS (see client.js) — import the default namespace
// for runtime values like the ClientError class.
import mattermost from "@mattermost/client";
/**
 * Render a Mattermost API error verbatim (status code + message), never
 * swallowed. Appends the `server_error_id` and `detailed_error` when present
 * for traceability. Non-API errors fall through to their plain message.
 */
export function formatMattermostError(err) {
  if (err instanceof mattermost.ClientError) {
    const status = err.status_code ?? 0;
    const id = err.server_error_id ? ` [${err.server_error_id}]` : "";
    const detail =
      err.detailed_error && err.detailed_error !== err.message ? ` (${err.detailed_error})` : "";
    return `Mattermost API error ${status}: ${err.message}${id}${detail}`;
  }
  return err instanceof Error ? err.message : String(err);
}
