import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openOutbox } from "./outbox.js";
import { openCodeDelivery, startDelivery } from "./delivery.js";

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});
const sample = {
  kind: "dm",
  postId: "p".repeat(26),
  channelId: "c".repeat(26),
  rootId: "p".repeat(26),
  senderId: "s".repeat(26),
  createdAt: 1234,
};
function inboxFile() {
  const dir = mkdtempSync(join(tmpdir(), "mm-outbox-"));
  dirs.push(dir);
  return join(dir, "events.json");
}
it("recovers a pending notification after restart and reuses its admission ID after a lost response", async () => {
  const file = inboxFile();
  const before = openOutbox(file);
  before.enqueue(sample);
  before.checkpoint(1234);
  const sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, opts) => {
      expect(url.pathname).toBe("/api/session/ses_example/synthetic");
      expect(opts.redirect).toBe("error");
      const msg = JSON.parse(opts.body);
      sent.push(msg);
      if (sent.length === 1) throw new Error("lost response after admission");
      return Response.json({ data: { id: msg.id, sessionID: "ses_example", type: "synthetic" } });
    }),
  );
  const send = openCodeDelivery({
    url: "http://127.0.0.1:4096",
    sessionId: "ses_example",
    password: "test",
    account: "account",
  });
  let pump = startDelivery(before, send);
  await vi.waitFor(() => expect(sent.length).toBe(1));
  await pump.stop();
  const reopened = openOutbox(file);
  expect(reopened.getCheckpoint()).toBe(1234);
  reopened.enqueue(sample);
  pump = startDelivery(reopened, send);
  await vi.waitFor(() => expect(reopened.next()).toBeUndefined());
  await pump.stop();
  expect(sent[0]).toEqual(sent[1]);
  expect(sent[1]).toMatchObject({
    resume: true,
    delivery: "queue",
    metadata: { mattermost: sample },
  });
  expect(JSON.parse(readFileSync(file)).recent).toEqual([sample.postId]);
  reopened.enqueue(sample);
  expect(reopened.next()).toBeUndefined();
});
it("never acknowledges an HTML, unrelated, or redirect response as successful admission", async () => {
  const send = openCodeDelivery({
    url: "http://127.0.0.1:4096",
    sessionId: "ses_example",
    password: "test",
    account: "account",
  });
  for (const res of [
    Response.json({ data: { id: "other" } }),
    new Response("login"),
    new Response(null, { status: 302 }),
  ]) {
    vi.stubGlobal("fetch", async () => res);
    await expect(send(sample, new AbortController().signal)).rejects.toThrow();
  }
});
