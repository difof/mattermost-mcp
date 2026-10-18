import type { Client4 } from "@mattermost/client";
import type { Config } from "../config.js";

/**
 * An authenticated Mattermost context shared by every tool handler.
 * `call` executes its callback exactly once. The client's HTTP transport retries
 * safe reads and recovers authentication per request, without replaying writes
 * after an ambiguous network/server failure or a later callback failure.
 */
export interface MattermostSession {
  readonly client: Client4;
  readonly config: Config;
  readonly userId: string;
  call<T>(fn: (client: Client4) => Promise<T>): Promise<T>;
}
