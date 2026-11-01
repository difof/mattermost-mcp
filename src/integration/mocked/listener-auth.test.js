import { once } from "node:events";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { expect, it } from "vitest";
import { startListener } from "../../events/listener.js";
import { createSession } from "../../mattermost/client.js";

it("recovers an expired password session rejected at the WebSocket upgrade without a foreground request", async () => {
  const me = { id: "a".repeat(26), username: "fixture" };
  let auth = "first",
    logins = 0,
    upgrades = 0;
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/v4/users/login" && req.method === "POST") {
      req.resume();
      logins++;
      res.setHeader("Token", auth);
      return res.end(JSON.stringify(me));
    }
    if (
      req.url === "/api/v4/users/me" &&
      req.headers.authorization?.toLowerCase() === "bearer " + auth
    )
      return res.end(JSON.stringify(me));
    res
      .writeHead(401)
      .end('{"id":"api.context.session_expired","message":"expired","status_code":401}');
  });
  const sockets = new WebSocketServer({
    server,
    path: "/api/v4/websocket",
    verifyClient: ({ req }) => {
      upgrades++;
      return req.headers.authorization === "Bearer " + auth;
    },
  });
  sockets.on("connection", (s) => s.send(JSON.stringify({ event: "hello", seq: 0, data: {} })));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let stop, deadline;
  try {
    const session = await createSession({
      url: "http://127.0.0.1:" + server.address().port,
      auth: { mode: "password", loginId: "fixture", password: "fake-password" },
      resilience: { timeoutMs: 2000, maxRetries: 0, baseDelayMs: 1 },
    });
    auth = "second";
    await new Promise((resolve, reject) => {
      deadline = setTimeout(
        () => reject(new Error("Passive authentication did not recover")),
        4500,
      );
      stop = startListener({
        session,
        invalidateDirectory: () => {},
        refreshDirectory: async () => ({
          me,
          channels: new Map(),
          isCurrent: () => true,
          denyContent: () => {},
        }),
        checkpoint: () => {},
        onStatus: (s) => {
          if (s === "connected") resolve();
        },
      });
    });
    expect(logins).toBe(2);
    expect(upgrades).toBe(2);
  } finally {
    clearTimeout(deadline);
    await stop?.();
    for (const s of sockets.clients) s.terminate();
    await new Promise((r) => sockets.close(r));
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  }
});
