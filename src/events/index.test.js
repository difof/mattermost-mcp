import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { startEvents } from "./index.js";
import { startListener } from "./listener.js";

const channel = "c".repeat(26);
vi.mock("./listener.js", () => ({ startListener: vi.fn(() => async () => {}) }));
vi.mock("./cache-access.js", () => ({
  cacheAccess: async () => ({ check: async () => {}, allows: (id) => id === channel }),
}));

function targets(token, paths) {
  return {
    resolve({ callback_url: url }) {
      if (!paths.includes(url)) throw new Error("Removed test destination");
      return { kind: "webhook", url, headers: { authorization: "Bearer " + token } };
    },
  };
}

it("stages a retention change without pruning; failed activation rolls back rows and leases; reload preserves permitted subscriptions and sends using rotated credentials", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "mm-event-runtime-"));
  const hookA = "https://fixture.example/a",
    hookB = "https://fixture.example/b";
  const config = {
    url: "https://mattermost.example",
    guardrails: { teamAllowlist: [], channelAllowlist: [], readOnly: false },
  };
  const session = { userId: "u".repeat(26), config };
  const before = targets("old", [hookA, hookB]),
    after = targets("new", [hookB]);
  const stops = [];
  const begin = async (options) => {
    const stop = await startEvents({ config, session, stateDir, targets: before, ...options });
    stops.push(stop);
    return stop;
  };
  const now = Date.now();
  const record = (postId, createdAt) => ({
    postId: postId.repeat(26),
    channelId: channel,
    rootId: postId.repeat(26),
    senderId: "p".repeat(26),
    channelType: "D",
    direction: "incoming",
    createdAt,
    updatedAt: createdAt,
    message: "test message",
    fileIds: [],
  });
  const sent = [];
  vi.stubGlobal("fetch", async (url, opts) => {
    sent.push({ url, authorization: opts.headers.authorization, body: JSON.parse(opts.body) });
    return new Response(null, { status: 204 });
  });
  try {
    const first = await begin({ retentionHours: 72 });
    const c = session.cache;
    const mid = record("m", now - 60 * 3600000),
      recent = record("r", now - 2000);
    c.applyBatch([mid, recent]);
    session.subscriptions.register({ callback_url: hookA, ttl_seconds: 120 }, {});
    const lease = session.subscriptions.register({ callback_url: hookB, ttl_seconds: 120 }, {});
    const staged = await begin({ retentionHours: 1, targets: after, deferActivation: true });
    expect(session.cache).toBe(c);
    expect(c.list().messages.map((r) => r.postId)).toContain(mid.postId);
    expect(session.subscriptions.list()).toHaveLength(2);
    expect(startListener).toHaveBeenCalledTimes(1);

    // A real SQLite failure after the prune but before lease revocation must roll both back.
    c.database.exec(
      "CREATE TRIGGER refuse_drop BEFORE DELETE ON subscriptions BEGIN SELECT RAISE(ABORT,'fixture'); END",
    );
    await expect(staged.activate()).rejects.toThrow();
    c.database.exec("DROP TRIGGER refuse_drop");
    await staged();
    expect(session.cache).toBe(c);
    expect(c.list().messages).toHaveLength(2);
    expect(session.subscriptions.list()).toHaveLength(2);
    expect(startListener).toHaveBeenCalledTimes(1);

    const readOnlyConfig = { ...config, guardrails: { ...config.guardrails, readOnly: true } };
    const quiet = await begin({
      config: readOnlyConfig,
      retentionHours: 1,
      targets: after,
      deferActivation: true,
    });
    await first();
    await quiet.activate();
    expect(
      session.cache.database
        .prepare("SELECT count(*) AS n FROM posts WHERE postId=?")
        .get(mid.postId).n,
    ).toBe(0);
    expect(session.subscriptions.list()).toEqual([lease]);
    const fresh = record("n", Date.now());
    startListener.mock.lastCall[0].enqueue(fresh);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent).toEqual([]);

    await quiet();
    await begin({ retentionHours: 96, targets: after });
    expect(startListener.mock.lastCall[0].retentionMs).toBe(96 * 3600000);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      url: hookB,
      authorization: "Bearer new",
      body: { subscriptionId: lease.subscriptionId, postId: fresh.postId },
    });
    expect(session.subscriptions.list()).toEqual([lease]);
  } finally {
    for (const stop of stops.reverse()) await stop();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    await rm(stateDir, { recursive: true, force: true });
  }
});
