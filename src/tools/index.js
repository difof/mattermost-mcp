import { userTools } from "./users.js";
import { messagingTools } from "./messaging.js";
import { channelTools } from "./channels.js";
import { fileTools } from "./files.js";
import { apiTools } from "./api.js";
/** Every tool exposed by the server, aggregated per domain. */
export const allTools = [
  ...userTools,
  ...messagingTools,
  ...channelTools,
  ...fileTools,
  ...apiTools,
];
