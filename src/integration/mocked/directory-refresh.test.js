import { expect, it, vi } from "vitest";
import { buildClient } from "../../mattermost/client.js";
import { createDirectoryRefresh } from "../../events/directory-refresh.js";
import { useMattermost } from "./mattermost-http-fixture.js";

const me = { id: "a".repeat(26), username: "agent" };
const conversation = { id: "b".repeat(26), type: "G", name: "group" };
const fixture = useMattermost({ user: me });
const query = { include_deleted: true };

it("discards a revoked in-flight snapshot before completing concurrent directory lookups", async () => {
  const f = fixture();
  const client = buildClient(f.url, 2000);
  client.setToken("test-only-personal-pat");
  const session = { client, userId: me.id, config: { guardrails: f.guardrails } };
  const store = { replace: vi.fn(), remove: vi.fn() };
  const cache = { directory: store, retainChannels: vi.fn(), purgeChannel: vi.fn() };
  const directory = createDirectoryRefresh(session, cache);
  let started = false,
    release;
  const hold = new Promise((r) => {
    release = r;
  });

  f.expect("GET", "/users/me", { reply: me });
  f.expect("GET", "/users/me/channels", {
    query,
    reply: [conversation],
    inspectBody: async () => {
      started = true;
      await hold;
    },
  });
  f.expect("GET", "/users/me", { reply: me });
  f.expect("GET", "/users/me/channels", { query, reply: [] });
  try {
    const a = directory.refresh(),
      b = directory.refresh();
    await vi.waitFor(() => expect(started).toBe(true));
    directory.invalidate(conversation.id);
    expect(store.remove).toHaveBeenCalledWith(conversation.id);
    release();
    const snapshots = await Promise.all([a, b]);
    expect(snapshots.map((s) => s.channels.size)).toEqual([0, 0]);
    expect(store.replace.mock.calls).toEqual([[me, new Map()]]);
    // An unavailable upstream must not fall back to a previous cached snapshot.
    f.expect("GET", "/users/me", { reply: me });
    f.expect("GET", "/users/me/channels", {
      query,
      status: 403,
      reply: { message: "not allowed" },
    });
    await expect(directory.refresh()).rejects.toThrow();
    expect(store.replace).toHaveBeenCalledTimes(1);
  } finally {
    release();
    await directory.close();
  }
});
