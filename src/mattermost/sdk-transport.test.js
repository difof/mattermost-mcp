import { once } from "node:events";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { buildClient } from "./client.js";
import { fetchFileContent } from "./files.js";
import { callApi } from "../api/client.js";

async function serve(handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: "http://127.0.0.1:" + server.address().port,
    close: () =>
      new Promise((done) => {
        server.close(done);
        server.closeAllConnections();
      }),
  };
}

it("never forwards a password, MFA or ordinary post body to a redirect destination", async () => {
  let received = 0;
  const destination = await serve((_req, res) => {
    received++;
    res.end("{}");
  });
  const origin = await serve((_req, res) =>
    res.writeHead(307, { location: destination.url }).end(),
  );
  try {
    const c = buildClient(origin.url, 1000);
    await expect(c.login("fixture", "private-password", "mfa")).rejects.toThrow();
    await expect(
      c.createPost({ channel_id: "allowed", message: "private-post" }),
    ).rejects.toThrow();
    expect(received).toBe(0);
  } finally {
    await Promise.all([origin.close(), destination.close()]);
  }
});

it("enforces the decoded-byte operator ceiling for SDK, raw API and file downloads", async () => {
  const server = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.write('{"value":"');
    res.end("x".repeat(64) + '"}');
  });
  try {
    const c = buildClient(server.url, 1000, 32);
    await expect(c.getMe()).rejects.toThrow(/exceeds/);
    await expect(fetchFileContent(c, "file", 1000)).rejects.toThrow(/MM_MAX_RESPONSE_BYTES/);
    await expect(
      callApi(c, { method: "GET", path: "/api/v4/users/me", responses: {} }, { max_bytes: 1000 }),
    ).rejects.toThrow(/MM_MAX_RESPONSE_BYTES/);
  } finally {
    await server.close();
  }
});
