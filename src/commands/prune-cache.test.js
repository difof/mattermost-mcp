import { mkdtemp, mkdir, rm, readFile, link, symlink, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { openCache } from "../events/cache.js";
import { openDirectory } from "../events/directory.js";
import { pruneScope } from "./prune-cache.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
const scope = "a".repeat(64),
  other = "b".repeat(64),
  now = 10 * 3600_000;
let state, dir;
afterEach(async () => {
  if (state) await rm(state, { recursive: true, force: true });
});
async function setup() {
  state = await mkdtemp(join(tmpdir(), "offline-prune-"));
  dir = join(state, "cache");
  await mkdir(dir, { mode: 0o700 });
  return join(dir, scope + ".sqlite3");
}
function seed(db, n, at) {
  const id = String(n).repeat(26);
  db.apply({
    postId: id,
    rootId: id,
    channelId: "c".repeat(26),
    senderId: "p".repeat(26),
    createdAt: at,
    updatedAt: at,
    channelType: "P",
    direction: "incoming",
    message: "private fixture",
  });
}
it("expires only rows in the named offline scope; no account, directory or body is printed", async () => {
  const path = await setup(),
    opts = { now: () => now };
  const db = await openCache(path, opts),
    second = await openCache(join(dir, other + ".sqlite3"), opts);
  seed(db, 1, now - 2 * 3600_000);
  seed(db, 2, now);
  seed(second, 1, now - 2 * 3600_000);
  const d = openDirectory(db);
  d.replace(
    { id: "p".repeat(26), username: "fixture" },
    new Map([["c".repeat(26), { id: "c".repeat(26), type: "P" }]]),
  );
  db.close();
  second.close();
  expect(pruneScope(state, scope, 1, now)).toEqual({ posts: 1, receipts: 0, subscriptions: 0 });
  const first = await openCache(path, opts),
    untouched = await openCache(join(dir, other + ".sqlite3"), opts);
  try {
    expect(first.list().messages.map((p) => p.postId)).toEqual(["2".repeat(26)]);
    expect(openDirectory(first).list().conversations).toHaveLength(1);
    expect(untouched.list().messages).toHaveLength(1);
  } finally {
    first.close();
    untouched.close();
  }
});
it("rejects unknown schemas, sidecars, symlinks and hard links without changing a target", async () => {
  const path = await setup();
  const db = await openCache(path, { now: () => now });
  db.database.exec("CREATE TRIGGER extra AFTER DELETE ON posts BEGIN DELETE FROM checkpoint; END");
  db.close();
  const before = await readFile(path);
  expect(() => pruneScope(state, scope, 1, now)).toThrow(/schema/);
  expect(await readFile(path)).toEqual(before);
  expect(() => pruneScope(state, "../" + scope, 1, now)).toThrow(/exact/);
  expect(() => pruneScope(state, other, 1, now)).toThrow();
  await expect(readFile(join(dir, other + ".sqlite3"))).rejects.toMatchObject({ code: "ENOENT" });
  const otherFile = join(dir, other + ".sqlite3");
  await symlink(path, otherFile);
  expect(() => pruneScope(state, other, 1, now)).toThrow(/unaliased/);
  await rm(otherFile);
  await link(path, otherFile);
  expect(() => pruneScope(state, scope, 1, now)).toThrow(/unaliased/);
  await rm(otherFile);
  await symlink(path, path + "-wal");
  expect(() => pruneScope(state, scope, 1, now)).toThrow(/journal/);
});

it.each([false, true])(
  "prunes the published legacy schema without migrating it (has read counts: %s)",
  async (withReadCount) => {
    const path = await setup(),
      db = new DatabaseSync(path);
    try {
      await chmod(path, 0o600);
      db.exec(`CREATE TABLE posts (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, postId TEXT NOT NULL UNIQUE, channelId TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        senderId TEXT, rootId TEXT, channelType TEXT, direction TEXT, isMention INTEGER, message TEXT, fileIds TEXT
      );
      CREATE INDEX timeline ON posts(createdAt DESC, postId DESC);
      CREATE INDEX channel_timeline ON posts(channelId, createdAt DESC, postId DESC);
      CREATE INDEX thread_replies ON posts(channelId,rootId) WHERE rootId IS NOT NULL;
      CREATE INDEX tombstone_age ON posts(updatedAt) WHERE message IS NULL;
      CREATE TABLE checkpoint (id INTEGER PRIMARY KEY CHECK(id=1), time INTEGER NOT NULL);`);
      if (withReadCount)
        db.exec(
          "ALTER TABLE posts ADD COLUMN readCount INTEGER NOT NULL DEFAULT 0 CHECK(readCount >= 0); CREATE INDEX unread_timeline ON posts(createdAt DESC, postId DESC) WHERE message IS NOT NULL AND readCount=0",
        );
      db.prepare(
        "INSERT INTO posts(postId,channelId,createdAt,updatedAt,message) VALUES(?,?,?,?,?)",
      ).run("1".repeat(26), "c".repeat(26), 1, 1, "fixture");
    } finally {
      db.close();
    }
    expect(pruneScope(state, scope, 1, now)).toEqual({ posts: 1, receipts: 0, subscriptions: 0 });
    const checked = new DatabaseSync(path, { readOnly: true });
    try {
      const columns = checked
        .prepare("SELECT name FROM pragma_table_info('posts')")
        .all()
        .map((x) => x.name);
      expect(columns.includes("readCount")).toBe(withReadCount);
      expect(columns).not.toContain("verifiedView");
    } finally {
      checked.close();
    }
  },
);
