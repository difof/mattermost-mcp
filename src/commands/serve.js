import { resolveConfig } from "../credentials.js";
import { httpSettings } from "../http/config.js";
import { listenHttp } from "../http/listener.js";
import { log } from "../log.js";
import { createSession } from "../mattermost/client.js";

export async function runServe() {
  const settings = httpSettings();
  const config = resolveConfig();
  if (settings.token === config.auth.token)
    throw new Error("Use a separate HTTP bearer; do not reuse the Mattermost token");
  const session = await createSession(config);
  const http = await listenHttp(session, settings);
  let stopEvents;
  try {
    if (settings.eventsEnabled) {
      const { startEvents } = await import("../events/index.js");
      stopEvents = await startEvents({ config, session });
    }
  } catch (err) {
    await http.close();
    throw err;
  }
  log(`serving MCP at ${http.url}`);
  let stopping;
  const shutdown = () => {
    stopping ??= http
      .close()
      .finally(() => stopEvents?.())
      .catch(() => {
        log("service shutdown failed");
        process.exitCode = 1;
      });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
