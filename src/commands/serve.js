import { listenHttp } from "../http/listener.js";
import { log } from "../log.js";
import { serviceRuntime } from "../service/runtime.js";

export async function runServe() {
  const runtime = await serviceRuntime();
  const http = await listenHttp(runtime.getSession, runtime.http, runtime.admin);
  try {
    await runtime.start();
  } catch (err) {
    await http.close();
    await runtime.close();
    throw err;
  }
  log(`serving MCP at ${http.url}`);
  let stopping;
  const shutdown = () => {
    stopping ??= http
      .close()
      .finally(() => runtime.close())
      .catch(() => {
        log("service shutdown failed");
        process.exitCode = 1;
      });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
