import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { makeMcpServer } from "../server.js";
import { makeAdminMcpServer } from "../service/admin-mcp.js";
import { log } from "../log.js";

const HOST = "127.0.0.1";
// Keep management reachable even if the ordinary request size is set too low.
const ADMIN_BODY_BYTES = 16 * 1024;

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
    return { value: JSON.parse(Buffer.concat(chunks, size).toString("utf8")), size };
  } catch {
    return { status: 400 };
  }
}

function authorized(req, token) {
  if (!token || req.headersDistinct.authorization?.length !== 1) return false;
  const expected = Buffer.from("Bearer " + token);
  const actual = Buffer.from(req.headers.authorization ?? "");
  return actual.length === expected.length && timingSafeEqual(expected, actual);
}

function unauthorized(res) {
  return reject(res, 401, "Bearer authentication required", { "www-authenticate": "Bearer" });
}

async function dispatch(mcp, req, res, value) {
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, value);
  } finally {
    await mcp.close();
  }
}

function requestHandler(sessionOrGetter, settings, admin) {
  const acquire =
    typeof sessionOrGetter === "function"
      ? (sessionOrGetter.acquire ?? (() => ({ session: sessionOrGetter() })))
      : () => ({ session: sessionOrGetter });
  return async (req, res) => {
    if (!loopbackRequest(req)) return reject(res, 403, "Invalid Host or Origin");
    const management = req.url === "/mcp/admin";
    if (management ? !admin || !settings.adminToken : req.url !== "/mcp") {
      return reject(res, 404, "Not found");
    }
    // Select the credential by endpoint, never by the caller's requested tool name.
    const key = management ? "adminToken" : "token";
    if (!authorized(req, settings[key])) return unauthorized(res);
    if (req.method !== "POST") return reject(res, 405, "Use POST", { allow: "POST" });
    if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
      return reject(res, 415, "Expected application/json");
    }
    const body = await requestBody(req, management ? ADMIN_BODY_BYTES : settings.maxBodyBytes);
    if (body.status)
      return reject(res, body.status, body.status === 413 ? "Request too large" : "Invalid JSON");
    if (res.destroyed) return;
    // A credential can rotate while a slow request is uploading its body.
    if (!authorized(req, settings[key])) return unauthorized(res);
    if (!management && body.size > settings.maxBodyBytes)
      return reject(res, 413, "Request too large");
    if (management) return dispatch(makeAdminMcpServer(admin), req, res, body.value);

    const lease = acquire();
    try {
      if (!lease?.session || (settings.eventsEnabled && !lease.session.cache)) {
        return reject(res, 503, "MCP service is reconfiguring");
      }
      return await dispatch(makeMcpServer(lease.session), req, res, body.value);
    } finally {
      lease?.release?.();
    }
  };
}

export async function listenHttp(sessionOrGetter, settings, admin) {
  const handle = requestHandler(sessionOrGetter, settings, admin);
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
