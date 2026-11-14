import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openCache } from "./cache.js";
import { callbackTargets, deliverCallback } from "./callbacks.js";
import { createSubscriptions } from "./subscriptions.js";

const cleanups = [];
const start = 1750000000000,
  hookA = "https://notifications.example/a",
  hookB = "https://notifications.example/b";
const id = (n) => String(n).padStart(26, "0");
function post(n, overrides = {}) {
  return {
    postId: id(n),
    channelId: id(111),
    rootId: id(n),
    senderId: id(222),
    channelType: "D",
    direction: "outgoing",
    isMention: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    message: "private-body-not-to-callback",
    fileIds: [],
    ...overrides,
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
});
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function config() {
  const directory = mkdtempSync(join(tmpdir(), "mm-leases-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "hooks.json"),
    privateKey = join(directory, "secret");
  writeFileSync(privateKey, "fixture_secret\n", { mode: 0o600 });
  writeFileSync(file, JSON.stringify([{ url: hookA, bearer_file: privateKey }, { url: hookB }]), {
    mode: 0o600,
  });
  const targets = callbackTargets({
    MM_CALLBACK_TARGETS_FILE: file,
    MM_OPENCODE_URL: "http://127.0.0.1:49374",
    MM_OPENCODE_PASSWORD_FILE: privateKey,
  });
  return { directory, targets };
}
async function fixture() {
  const { directory, targets } = config(),
    file = join(directory, "messages.db");
  let cache, leases;
  const authorize = vi.fn(async (ids) => (id) => ids.includes(id));
  async function close() {
    await leases?.stop();
    leases = undefined;
    cache?.close();
    cache = undefined;
  }
  async function restart() {
    await close();
    cache = await openCache(file);
    leases = createSubscriptions({ cache, targets, account: "account", authorize });
  }
  await restart();
  cleanups.push(close);
  return {
    get cache() {
      return cache;
    },
    get leases() {
      return leases;
    },
    authorize,
    restart,
  };
}
it("never pushes by default, starts at registration and filters new posts until expiry", async () => {
  const h = await fixture(),
    requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, opts) => {
      requests.push({ url, payload: JSON.parse(opts.body), headers: opts.headers });
      return new Response(null, { status: 204 });
    }),
  );
  h.cache.apply(post(1));
  await vi.advanceTimersByTimeAsync(1000);
  expect(requests).toEqual([]);
  expect(h.authorize).not.toHaveBeenCalled();
  const filters = {
    direction: "outgoing",
    channelType: "D",
    channelId: id(111),
    senderId: id(222),
    isMention: false,
  };
  h.leases.register({ callback_url: hookA, ttl_seconds: 1 }, filters);
  h.cache.applyBatch([
    post(2, { createdAt: start }),
    post(3, { direction: "incoming" }),
    post(4, { channelId: id(333) }),
    post(5, { isMention: true }),
    post(6),
  ]);
  h.leases.wake();
  await vi.advanceTimersByTimeAsync(60);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    url: hookA,
    payload: { postId: id(6), direction: "outgoing" },
    headers: { authorization: "Bearer fixture_secret" },
  });
  expect(JSON.stringify(requests[0].payload)).not.toContain("private-body");
  await vi.advanceTimersByTimeAsync(995);
  h.cache.apply(post(7));
  h.leases.wake();
  await vi.advanceTimersByTimeAsync(1000);
  expect(requests).toHaveLength(1);
  expect(h.leases.list()).toEqual([]);
});
it("keeps per-lease progress across restart and retries an uncertain callback with the same key without blocking a healthy hook", async () => {
  const h = await fixture(),
    calls = [];
  let failing = true;
  vi.stubGlobal("fetch", async (url, opts) => {
    calls.push({ url, key: opts.headers["idempotency-key"], body: opts.body });
    if (url === hookA && failing) throw new Error("lost receipt");
    return new Response(null, { status: 202 });
  });
  for (const url of [hookA, hookB]) h.leases.register({ callback_url: url, ttl_seconds: 30 }, {});
  h.cache.apply(post(10));
  h.leases.wake();
  await vi.advanceTimersByTimeAsync(80);
  expect(calls.map((c) => c.url).sort()).toEqual([hookA, hookB]);
  failing = false;
  await h.restart();
  await vi.advanceTimersByTimeAsync(2100);
  const a = calls.filter((c) => c.url === hookA),
    b = calls.filter((c) => c.url === hookB);
  expect(a).toHaveLength(2);
  expect(a[1]).toEqual(a[0]);
  expect(b).toHaveLength(1);
  expect(a[0].key).not.toBe(b[0].key);
});
it("backs off an unverified channel without delaying an independently authorized lease", async () => {
  const h = await fixture();
  const send = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", send);
  h.leases.register({ callback_url: hookA, ttl_seconds: 30 }, { channelId: id(111) });
  h.leases.register({ callback_url: hookB, ttl_seconds: 30 }, { channelId: id(333) });
  h.authorize.mockResolvedValueOnce((channel) => (channel === id(333) ? true : undefined));
  h.cache.applyBatch([post(1), post(2, { channelId: id(333) })]);
  h.leases.wake();
  await vi.advanceTimersByTimeAsync(80);
  expect(send.mock.calls.map(([url]) => url)).toEqual([hookB]);
  expect(h.leases.list().find((l) => l.callbackUrl === hookA).deliveryFailures).toBe(1);
  await vi.advanceTimersByTimeAsync(2100);
  expect(send.mock.calls.map(([url]) => url)).toEqual([hookB, hookA]);
});
it("does not send a different channel's candidate discovered after an authorization purge", async () => {
  const h = await fixture();
  const send = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", send);
  h.authorize.mockImplementationOnce(async (ids) => {
    h.cache.purgeChannel(id(111));
    return (channel) => ids.includes(channel);
  });
  h.leases.register({ callback_url: hookA, ttl_seconds: 30 }, {});
  h.cache.applyBatch([post(31), post(32, { channelId: id(333) })]);
  h.leases.wake();
  await vi.advanceTimersByTimeAsync(80);
  expect(send).not.toHaveBeenCalled();
  expect(h.authorize.mock.calls[0][0]).toEqual([id(111)]);
  await vi.advanceTimersByTimeAsync(1020);
  expect(h.authorize.mock.calls[1][0]).toEqual([id(333)]);
  expect(send).toHaveBeenCalledTimes(1);
  expect(JSON.parse(send.mock.calls[0][1].body).postId).toBe(id(32));
});
it("aborts an in-flight callback on unsubscribe and sends no subsequent post", async () => {
  const h = await fixture(),
    signals = [];
  vi.stubGlobal("fetch", async (_url, opts) => {
    signals.push(opts.signal);
    return new Promise((_ok, reject) =>
      opts.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
    );
  });
  const { subscriptionId } = h.leases.register({ callback_url: hookB, ttl_seconds: 100 }, {});
  h.cache.apply(post(12));
  h.leases.wake();
  await vi.advanceTimersByTimeAsync(35);
  expect(signals).toHaveLength(1);
  expect(h.leases.unsubscribe(subscriptionId)).toEqual({ removed: true });
  expect(signals[0].aborted).toBe(true);
  h.cache.apply(post(13));
  h.leases.wake();
  await vi.advanceTimersByTimeAsync(2030);
  expect(signals).toHaveLength(1);
  expect(h.leases.list()).toEqual([]);
});
it("requires operator-enabled destinations, scopes credentials by origin, never follows a redirect, and checks the synthetic receipt", async () => {
  const { targets } = config();
  for (const raw of [
    "http://169.254.169.254/latest/meta-data",
    "http://127.0.0.1:49374/api/config",
    "file:///tmp/local",
    "https://notifications.example/other",
    "https://user:pass@notifications.example/a",
    hookA + "?key=secret",
    hookA + "#fragment",
    "https://notifications.example.evil/a",
  ])
    expect(() => targets.resolve({ callback_url: raw })).toThrow();
  expect(() => targets.resolve({ session_id: "ses_x", callback_url: hookA })).toThrow();
  const oc = targets.resolve({ session_id: "ses_example" }),
    sig = new AbortController().signal;
  expect(targets.resolve({ callback_url: hookB }).headers).toEqual({});
  expect(oc.headers.authorization).toMatch(/^Basic /);
  const req = vi.fn();
  vi.stubGlobal("fetch", req);
  const send = () => deliverCallback(oc, "lease", "account", post(14), sig);
  req.mockResolvedValueOnce(
    new Response(null, { status: 302, headers: { location: "https://other.example" } }),
  );
  await expect(send()).rejects.toThrow("302");
  expect(req).toHaveBeenCalledTimes(1);
  expect(req.mock.calls[0][1].redirect).toBe("manual");
  req.mockResolvedValueOnce(
    Response.json({ data: { id: "wrong", sessionID: oc.sessionId, type: "synthetic" } }),
  );
  await expect(send()).rejects.toThrow("receipt mismatch");
  req.mockResolvedValueOnce(new Response("x".repeat(65537)));
  await expect(send()).rejects.toThrow("Oversized");
  req.mockImplementationOnce(async (_url, opts) =>
    Response.json({
      data: { id: JSON.parse(opts.body).id, sessionID: oc.sessionId, type: "synthetic" },
    }),
  );
  await send();
  expect(JSON.parse(req.mock.lastCall[1].body)).toMatchObject({
    resume: true,
    delivery: "queue",
    metadata: { mattermost: { postId: id(14) } },
  });
  expect(req.mock.lastCall[1].body).not.toContain("private-body");
});

it("keeps permanent leases and a pinned template payload across restart and validates durable consumer receipts", async () => {
  const { directory } = config(),
    file = join(directory, "permanent.db");
  const { notificationTemplate } = await import("./templates.js");
  let target = {
    kind: "webhook",
    url: hookA,
    headers: { authorization: "Bearer fixture_secret" },
    receipt: true,
    template: notificationTemplate("first {{postId}}"),
  };
  const targets = { resolve: () => target },
    calls = [];
  let good = false,
    cache = await openCache(file);
  let leases = createSubscriptions({
    cache,
    targets,
    account: "scope",
    accountId: "assistant",
    authorize: async () => () => true,
  });
  cleanups.push(async () => {
    await leases.stop();
    cache.close();
  });
  vi.stubGlobal("fetch", async (_url, opts) => {
    const payload = JSON.parse(opts.body);
    calls.push(payload);
    return Response.json({ id: good ? payload.id : "wrong", accepted: true });
  });
  const lease = leases.register(
    { callback_url: hookA, persistent: true },
    { direction: "incoming" },
  );
  expect(lease).toMatchObject({ persistent: true, expiresAt: null });
  cache.apply(post(70, { direction: "incoming" }));
  leases.wake();
  await vi.advanceTimersByTimeAsync(80);
  expect(calls).toHaveLength(1);
  expect(leases.list()[0].deliveryFailures).toBe(1);
  await leases.stop();
  cache.close();
  target = { ...target, template: notificationTemplate("changed {{message}}") };
  cache = await openCache(file);
  leases = createSubscriptions({
    cache,
    targets,
    account: "scope",
    accountId: "assistant",
    authorize: async () => () => true,
  });
  good = true;
  await vi.advanceTimersByTimeAsync(2100);
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(calls[0]);
  expect(calls[0]).toMatchObject({
    accountId: "assistant",
    eventType: "posted",
    text: "first " + id(70),
  });
  vi.setSystemTime(start + 49 * 3600000);
  leases.prune();
  expect(leases.list()).toHaveLength(1);
  expect(cache.database.prepare("SELECT count(*) AS n FROM pending_callbacks").get().n).toBe(0);
});
it("suppresses only known service outgoing echoes while retaining incoming posts from another controlled account", async () => {
  const h = await fixture(),
    sent = [];
  vi.stubGlobal("fetch", async (_url, opts) => {
    sent.push(JSON.parse(opts.body));
    return new Response(null, { status: 204 });
  });
  h.leases.register({ callback_url: hookA, persistent: true }, { includeServiceOutgoing: false });
  h.cache.sends.begin("send-one");
  h.cache.sends.complete("send-one", id(80));
  h.cache.sends.finish("send-one");
  h.cache.sends.begin("send-two");
  h.cache.sends.complete("send-two", id(81));
  h.cache.sends.finish("send-two");
  h.cache.apply(post(80, { direction: "outgoing" }));
  h.cache.apply(post(81, { direction: "incoming" }));
  h.leases.wake();
  await vi.advanceTimersByTimeAsync(1200);
  expect(sent.map((p) => p.postId)).toEqual([id(81)]);
});
