import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { makeMcpServer } from "../server.js";
import { log } from "../log.js";

const HOST = "127.0.0.1";

function reject(response, status, message, headers = {}) {
  response
    .writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
      connection: "close",
      ...headers,
    })
    .end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message } }));
}

function loopbackRequest(req) {
  const port = req.socket.localPort;
  const host = req.headers.host;
  const suffix = port === 80 ? "" : ":" + port;
  return (
    req.headersDistinct.host?.length === 1 &&
    [HOST + suffix, "localhost" + suffix].includes(host) &&
    (req.headers.origin === undefined || req.headers.origin === "http://" + host)
  );
}

async function requestBody(req, limit) {
  if (Number(req.headers["content-length"]) > limit) return { status: 413 };
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) return { status: 413 };
    chunks.push(chunk);
  }
  try {
    return { value: JSON.parse(Buffer.concat(chunks, size).toString("utf8")) };
  } catch {
    return { status: 400 };
  }
}

function requestHandler(session, { token, maxBodyBytes }) {
  const expected = Buffer.from("Bearer " + token);
  return async (req, res) => {
    if (!loopbackRequest(req)) return reject(res, 403, "Invalid Host or Origin");
    const actual = Buffer.from(req.headers.authorization ?? "");
    if (
      req.headersDistinct.authorization?.length !== 1 ||
      actual.length !== expected.length ||
      !timingSafeEqual(expected, actual)
    ) {
      return reject(res, 401, "Bearer authentication required", { "www-authenticate": "Bearer" });
    }
    if (req.url !== "/mcp") return reject(res, 404, "Not found");
    if (req.method !== "POST") return reject(res, 405, "Use POST", { allow: "POST" });
    if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
      return reject(res, 415, "Expected application/json");
    }
    const body = await requestBody(req, maxBodyBytes);
    if (body.status)
      return reject(res, body.status, body.status === 413 ? "Request too large" : "Invalid JSON");
    if (res.destroyed) return;
    const mcp = makeMcpServer(session);
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body.value);
    } finally {
      await mcp.close();
    }
  };
}

export async function listenHttp(session, settings) {
  const handle = requestHandler(session, settings);
  const http = createServer({ requestTimeout: 30000, headersTimeout: 10000 }, (req, res) => {
    handle(req, res).catch(() => {
      if (res.destroyed) return;
      log("HTTP request failed");
      if (res.headersSent) res.destroy();
      else reject(res, 500, "Internal error");
    });
  });
  await new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(settings.port, HOST, () => {
      http.off("error", reject);
      resolve();
    });
  });
  return {
    url: `http://${HOST}:${http.address().port}/mcp`,
    close: () =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => http.closeAllConnections(), 30000).unref();
        http.close((error) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
