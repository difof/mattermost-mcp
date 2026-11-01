// Explicit offline maintenance, not an automatic sweep. Never opens a scope by
// account name, migrates the target, or prints an identifier from the database.
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { initializeCache, retentionWindow } from "../events/cache.js";
import { openDirectory } from "../events/directory.js";
import { openLeaseStore } from "../events/subscription-store.js";

function assertPrivate(path, directory) {
  const stat = lstatSync(path);
  const privateOwner =
    process.platform === "win32" || (stat.uid === process.getuid() && !(stat.mode & 0o077));
  if (
    !privateOwner ||
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
    realpathSync(path) !== path
  )
    throw new Error(
      "Cache maintenance requires a private real directory and unaliased regular file",
    );
  return stat;
}

function schema(db) {
  return db
    .prepare("SELECT name, type, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' LIMIT 64")
    .all();
}

function verifySchema(db, DatabaseSync) {
  // Compare schema objects to ones built by the runtime, including index
  // expressions. Unexpected triggers/views/FKs must never run during a delete.
  const ref = new DatabaseSync(":memory:");
  try {
    const cache = initializeCache(ref, Date.now, retentionWindow(48));
    openDirectory(cache);
    openLeaseStore(cache, Date.now);
    const expected = new Map(schema(ref).map((row) => [row.name, row]));
    // SQLite appends each ALTER declaration to the stored CREATE statement.
    // Accept the exact published predecessors, not arbitrary missing columns.
    const current = expected.get("posts").sql;
    const withReadCounts = current.replace(", verifiedView INTEGER NOT NULL DEFAULT 0", "");
    const legacyPosts = new Set([
      withReadCounts,
      withReadCounts.replace(", readCount INTEGER NOT NULL DEFAULT 0 CHECK(readCount >= 0)", ""),
    ]);
    const found = new Set();
    for (const { name, type, sql } of schema(db)) {
      const known = expected.get(name);
      const legacy = name === "posts" && legacyPosts.has(sql);
      if (!known || type !== known.type || (!legacy && sql !== known.sql))
        throw new Error("Not a recognized unmodified Mattermost message cache schema");
      found.add(name);
    }
    if (
      ![
        "posts",
        "checkpoint",
        "timeline",
        "channel_timeline",
        "thread_replies",
        "tombstone_age",
      ].every((name) => found.has(name))
    )
      throw new Error("Not a recognized Mattermost message cache schema");
    return found;
  } finally {
    ref.close();
  }
}

export function pruneScope(stateDir, scope, hours, now = Date.now()) {
  if (!isAbsolute(stateDir) || !/^[0-9a-f]{64}$/.test(scope))
    throw new Error(
      "Specify an absolute --state-dir and an exact 64-character lowercase hexadecimal --scope",
    );
  const retention = retentionWindow(hours);
  const DatabaseSync = process.getBuiltinModule?.("node:sqlite")?.DatabaseSync;
  if (!DatabaseSync) throw new Error("Cache maintenance requires Node.js 22.13+ with node:sqlite");
  const base = resolve(stateDir),
    dir = join(base, "cache"),
    file = join(dir, scope + ".sqlite3");
  assertPrivate(base, true);
  assertPrivate(dir, true);
  const before = assertPrivate(file, false);
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    if (lstatSync(file + suffix, { throwIfNoEntry: false }))
      throw new Error(
        "Cache has a journal or WAL; recover it using its service before offline maintenance",
      );
  }
  const uri = pathToFileURL(file);
  uri.searchParams.set("mode", "rw"); // SQLite must not create a missing target.
  const db = new DatabaseSync(uri.href);
  try {
    db.exec(
      "PRAGMA trusted_schema=OFF; PRAGMA secure_delete=ON; PRAGMA busy_timeout=0; PRAGMA temp_store=MEMORY; BEGIN EXCLUSIVE",
    );
    const locked = assertPrivate(file, false);
    if (before.dev !== locked.dev || before.ino !== locked.ino)
      throw new Error("Cache changed while opening");
    if (db.prepare("PRAGMA journal_mode").get().journal_mode !== "delete")
      throw new Error("Not a recognized offline cache journal mode");
    const objects = verifySchema(db, DatabaseSync);
    const cutoff = now - retention;
    const posts = db
      .prepare(
        "DELETE FROM posts WHERE (message IS NOT NULL AND createdAt<=?) OR (message IS NULL AND updatedAt<=?)",
      )
      .run(cutoff, cutoff).changes;
    const expired = (table) =>
      objects.has(table)
        ? db.prepare("DELETE FROM " + table + " WHERE expires<=?").run(now).changes
        : 0;
    const receipts = expired("inbox_receipts"),
      subscriptions = expired("subscriptions");
    db.exec("COMMIT");
    return { posts, receipts, subscriptions };
  } finally {
    db.close(); // SQLite rolls back an uncommitted transaction on close.
  }
}

export function runPruneCache(args) {
  const { values } = parseArgs({
    args,
    options: {
      "state-dir": { type: "string" },
      scope: { type: "string" },
      "retention-hours": { type: "string" },
    },
  });
  if (!values["state-dir"] || !values.scope || !/^\d+$/.test(values["retention-hours"] ?? ""))
    throw new Error(
      "Usage: mattermost-mcp prune-cache --state-dir DIR --scope HASH --retention-hours N (offline scope only)",
    );
  const result = pruneScope(values["state-dir"], values.scope, Number(values["retention-hours"]));
  process.stdout.write(JSON.stringify(result) + "\n");
}
