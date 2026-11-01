import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCache } from "./cache.js";
import { openDirectory } from "./directory.js";

const id = (c) => c.repeat(26);
const me = { id: id("a"), username: "fixture", email: "ignored@example.test" };
const peer = id("b"),
  team = id("t");
const dm = { id: id("d"), type: "D", name: peer + "__" + me.id, last_post_at: 1000 };
const room = { id: id("p"), type: "P", name: "room", display_name: "Room_%", team_id: team };
const group = {
  id: id("g"),
  type: "G",
  name: "group",
  delete_at: 500,
  props: { unexpected: "not cached" },
};
const map = (...rows) => new Map(rows.map((c) => [c.id, c]));

let cache, dir;
async function fixture() {
  dir = await mkdtemp(join(tmpdir(), "conversation-directory-"));
  const file = join(dir, "account.sqlite3");
  const open = async () => {
    cache = await openCache(file);
    return openDirectory(cache);
  };
  return { directory: await open(), open };
}
afterEach(async () => {
  cache?.close();
  cache = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
});

it("keeps a bounded, searchable directory after post expiry and process reopen", async () => {
  const { directory, open } = await fixture();
  const self = { ...dm, id: id("s"), name: me.id + "__" + me.id, last_post_at: 0 };
  const invalidPeer = { ...dm, id: id("x"), name: peer + "__" + id("z") };
  directory.replace(me, map(dm, group, room, self, invalidPeer));
  cache.prune();
  cache.close();
  cache = undefined;
  const persisted = await open();
  const first = persisted.list({ limit: 2 }),
    next = persisted.list({ cursor: first.nextCursor, limit: 3 });
  expect(first.account).toEqual({ id: me.id, username: me.username });
  expect(first.refreshedAt).toBeGreaterThan(0);
  expect(first.conversations.concat(next.conversations).map((c) => c.id)).toEqual(
    [dm, group, room, self, invalidPeer].map((c) => c.id),
  );
  expect(next.nextCursor).toBeNull();
  expect(persisted.list({ peer_user_id: peer }).conversations).toEqual([
    {
      id: dm.id,
      type: "D",
      name: dm.name,
      displayName: "",
      archived: false,
      peerUserId: peer,
      teamId: null,
      lastPostAt: 1000,
    },
  ]);
  expect(persisted.list({ peer_user_id: me.id }).conversations.map((c) => c.id)).toEqual([self.id]);
  expect(persisted.list({ channel_id: invalidPeer.id }).conversations[0].peerUserId).toBeNull();
  expect(persisted.list({ team_id: team, query: "_%" }).conversations.map((c) => c.id)).toEqual([
    room.id,
  ]);
  expect(persisted.list({ channel_type: "G" }).conversations[0]).toMatchObject({
    archived: true,
    peerUserId: null,
  });
  expect(persisted.list({ channel_type: "G" }).conversations[0]).not.toHaveProperty("props");
});

it("atomically updates names and membership; failures do not replace the last valid account snapshot", async () => {
  const { directory } = await fixture();
  expect(() => directory.list()).toThrow("not been synchronized");
  directory.replace(me, map(room, group, dm));
  const username = "renamed",
    renamed = { ...room, display_name: "New display" };
  directory.replace({ ...me, username }, map(renamed, group));
  expect(directory.list().account.username).toBe(username);
  expect(directory.list({ query: "new" }).conversations.map((c) => c.id)).toEqual([room.id]);
  expect(directory.list({ channel_id: dm.id }).conversations).toEqual([]);
  const before = directory.list();
  expect(() =>
    directory.replace(
      me,
      map({ ...renamed, display_name: "uncommitted" }, { ...dm, team_id: "invalid" }),
    ),
  ).toThrow("Invalid directory team");
  expect(() => directory.replace({ ...me, id: peer }, map(dm))).toThrow(
    "Directory account mismatch",
  );
  expect(directory.list()).toEqual(before);
  directory.remove(group.id);
  expect(directory.list().conversations.map((c) => c.id)).toEqual([room.id]);
  directory.replace(me, map());
  expect(directory.list().conversations).toEqual([]);
});
