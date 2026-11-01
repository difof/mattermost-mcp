import { createHash } from "node:crypto";
import { z } from "zod";

// Pinned v11 keeps recently submitted pending IDs in a short-lived server cache.
// It is not a durable send receipt; never replay an ambiguous write automatically.
export const postRequestId = z
  .string()
  .uuid()
  .optional()
  .describe(
    "Optional UUID for this send intent. On an immediate retry reuse the same arguments; Mattermost's short-lived pending-post cache can deduplicate it. Check history after an uncertain response.",
  );
export function pendingId(args, userId, channelId) {
  if (!args.request_id) return {};
  const key = createHash("sha256")
    .update(JSON.stringify([userId, channelId, args.request_id]))
    .digest("hex");
  return { pending_post_id: "mcp-" + key };
}
