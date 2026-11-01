import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// The SDK owns protocol replies. The service owns the lifetime of tool work,
// even when there is no longer a client socket on which to send the reply.
export async function dispatchExchange(createServer, req, res, value, outputLimit) {
  const control = new AbortController();
  const jobs = new Set();
  let finish;
  const abandoned = new Promise((resolve) => {
    finish = resolve;
  });
  const disconnect = () => {
    if (!res.writableFinished) {
      control.abort();
      finish();
    }
  };
  const timer = setTimeout(() => {
    disconnect();
    res.destroy();
  }, 120_000).unref();
  res.once("close", disconnect);
  const exchange = {
    signal: control.signal,
    outputLimit,
    async track(run) {
      control.signal.throwIfAborted();
      const job = Promise.resolve().then(() => {
        control.signal.throwIfAborted();
        return run();
      });
      jobs.add(job);
      try {
        return await job;
      } finally {
        jobs.delete(job);
      }
    },
  };
  let mcp;
  try {
    mcp = createServer(exchange);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await mcp.connect(transport);
    if (res.destroyed) return;
    await Promise.race([transport.handleRequest(req, res, value), abandoned]);
    // handleRequest can resolve when Node has only queued the response. Keep
    // its output reservation until the socket flushes or the client goes away.
    if (!res.writableFinished && !res.destroyed) {
      await Promise.race([new Promise((resolve) => res.once("finish", resolve)), abandoned]);
    }
  } finally {
    clearTimeout(timer);
    res.off("close", disconnect);
    control.abort();
    try {
      await mcp?.close();
    } finally {
      await Promise.allSettled(jobs);
    }
  }
}
