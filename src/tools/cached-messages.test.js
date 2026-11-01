import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClient } from "../mattermost/client.js";
import { openCache } from "../events/cache.js";
import { cachedMessagesTool } from "./cached-messages.js";
import { dispatchToolCall, toMcpTool } from "./registry.js";

it("counts only authorized inbox results and shares unread claims across concurrent agents", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mm-inbox-reads-"));
  const file = join(dir, "inbox.sqlite");
  const channelId = "c".repeat(26);
  let contentStatus = 503;
  vi.stubGlobal("fetch", async (url) => {
    const path = new URL(url).pathname;
    if (path === "/api/v4/users/me/channels") return Response.json([{ id: channelId, type: "D" }]);
    if (path === "/api/v4/channels/" + channelId + "/posts")
      return Response.json({ posts: {}, order: [] }, { status: contentStatus });
    throw new Error("Unexpected Mattermost route");
  });
  const dbs = [];
  try {
    // Independent connections share the SQLite file, not a JavaScript lock.
    dbs.push(await openCache(file), await openCache(file));
    const records = [1, 2, 3].map((n) => {
      const id = String(n).repeat(26),
        at = Date.now() - 1000 + n;
      return {
        postId: id,
        channelId,
        rootId: id,
        senderId: "u".repeat(26),
        channelType: "D",
        direction: "incoming",
        message: String(n),
        createdAt: at,
        updatedAt: at,
      };
    });
    dbs[0].applyBatch(records);
    const call = (i, args) => {
      const session = {
        cache: dbs[i],
        cacheStatus: "connected",
        client: buildClient("http://example.invalid", 0),
        config: { guardrails: { readOnly: true, teamAllowlist: [], channelAllowlist: [] } },
      };
      return dispatchToolCall([cachedMessagesTool], { session }, cachedMessagesTool.name, args);
    };
    const pull = async (i, args) => {
      const result = await call(i, args);
      expect(result.isError, result.content[0].text).toBeFalsy();
      return JSON.parse(result.content[0].text);
    };
    expect(toMcpTool(cachedMessagesTool).annotations.readOnlyHint).toBe(false);
    expect((await call(0, {})).isError).toBe(true);
    expect(dbs[0].list().messages.map((p) => p.readCount)).toEqual([0, 0, 0]);
    contentStatus = 200;
    const unread = { unread_only: true, channel_id: channelId, limit: 1 };
    const pages = await Promise.all([pull(0, unread), pull(1, unread)]);
    expect(pages.flatMap((r) => r.messages.map((p) => [p.message, p.readCount])).sort()).toEqual([
      ["2", 1],
      ["3", 1],
    ]);
    const second = pages.find((r) => r.messages[0].message === "2");
    const last = await pull(0, { ...unread, cursor: second.nextCursor });
    expect(last.messages.map((p) => [p.message, p.readCount])).toEqual([["1", 1]]);
    expect(last.nextCursor).toBeNull();
    expect((await pull(1, unread)).messages).toEqual([]);
    // Before a failed increment, throw midway through a page to verify all-or-none counts.
    dbs[0].database.exec(
      "CREATE TRIGGER refuse_update BEFORE UPDATE OF readCount ON posts WHEN old.message='2' BEGIN SELECT RAISE(ABORT,'fixture'); END;",
    );
    expect((await call(0, {})).isError).toBe(true);
    expect(dbs[1].list().messages.map((p) => p.readCount)).toEqual([1, 1, 1]);
    dbs[0].database.exec("DROP TRIGGER refuse_update");
    expect((await pull(1, {})).messages.map((p) => p.readCount)).toEqual([2, 2, 2]);
  } finally {
    vi.unstubAllGlobals();
    for (const db of dbs) db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
