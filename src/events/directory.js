import { allowedChannelTypes, isMattermostId } from "./filter.js";

function peerId(name, myId) {
  const pair = name.split("__");
  if (pair.length !== 2 || !pair.every(isMattermostId)) return null;
  if (pair[0] === myId) return pair[1];
  return pair[1] === myId ? pair[0] : null;
}

function channelValues(channel, myId) {
  const { id, type, team_id, delete_at } = channel;
  if (!isMattermostId(id) || !allowedChannelTypes.has(type))
    throw new Error("Invalid directory channel");
  if (team_id && !isMattermostId(team_id)) throw new Error("Invalid directory team");
  if (delete_at != null && (!Number.isSafeInteger(delete_at) || delete_at < 0))
    throw new Error("Invalid directory archive timestamp");
  const name = typeof channel.name === "string" ? channel.name.slice(0, 256) : "";
  const display =
    typeof channel.display_name === "string" ? channel.display_name.slice(0, 512) : "";
  const last = channel.last_post_at;
  return [
    id,
    type,
    name,
    display,
    team_id || null,
    Number(delete_at > 0),
    type === "D" ? peerId(name, myId) : null,
    Number.isSafeInteger(last) && last >= 0 ? last : null,
  ];
}

function page(db, filters) {
  const { limit = 25, cursor, query } = filters;
  const where = [],
    params = [];
  for (const [field, value] of Object.entries({
    type: filters.channel_type,
    name: filters.exact_name,
    id: filters.channel_id,
    teamId: filters.team_id,
    peerUserId: filters.peer_user_id,
  })) {
    if (value === undefined) continue;
    where.push(field + " = ?");
    params.push(value);
  }
  if (cursor) {
    where.push("id > ?");
    params.push(cursor);
  }
  if (query) {
    // Search for literal text, not LIKE wildcards or SQL syntax.
    where.push("(instr(lower(name), lower(?)) OR instr(lower(displayName), lower(?)))");
    params.push(query, query);
  }
  const sql =
    "SELECT * FROM directory_channels" +
    (where.length ? " WHERE " + where.join(" AND ") : "") +
    " ORDER BY id LIMIT ?";
  const rows = db.prepare(sql).all(...params, limit + 1);
  const more = rows.length > limit;
  if (more) rows.pop();
  return {
    conversations: rows.map((row) => ({ ...row, archived: Boolean(row.archived) })),
    nextCursor: more ? rows.at(-1).id : null,
  };
}

/** The directory lives with the account/allowlist-scoped cache but has no post retention cutoff. */
export function openDirectory(cache) {
  const db = cache.database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS directory_account (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL,
      username TEXT NOT NULL, refreshedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS directory_channels (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, displayName TEXT NOT NULL,
      teamId TEXT, archived INTEGER NOT NULL, peerUserId TEXT, lastPostAt INTEGER
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS directory_peers ON directory_channels(peerUserId) WHERE peerUserId IS NOT NULL;
    CREATE INDEX IF NOT EXISTS directory_types ON directory_channels(type, id);
    CREATE INDEX IF NOT EXISTS directory_teams ON directory_channels(teamId, id) WHERE teamId IS NOT NULL;
  `);
  const account = db.prepare(
    "SELECT id,username,refreshedAt FROM directory_account WHERE singleton=1",
  );
  const setAccount = db.prepare(`INSERT INTO directory_account VALUES (1,?,?,?)
    ON CONFLICT(singleton) DO UPDATE SET username=excluded.username,refreshedAt=excluded.refreshedAt`);
  const upsert = db.prepare(`INSERT INTO directory_channels VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      (type,name,displayName,teamId,archived,peerUserId,lastPostAt) =
      (excluded.type,excluded.name,excluded.displayName,excluded.teamId,excluded.archived,excluded.peerUserId,excluded.lastPostAt)
    WHERE (type,name,displayName,teamId,archived,peerUserId,lastPostAt) IS NOT
      (excluded.type,excluded.name,excluded.displayName,excluded.teamId,excluded.archived,excluded.peerUserId,excluded.lastPostAt)`);
  const retain = db.prepare(
    "DELETE FROM directory_channels WHERE id NOT IN (SELECT value FROM json_each(?))",
  );
  const remove = db.prepare("DELETE FROM directory_channels WHERE id=?");
  return {
    replace(me, channels) {
      if (
        !isMattermostId(me?.id) ||
        typeof me.username !== "string" ||
        !me.username ||
        me.username.length > 256
      )
        throw new Error("Invalid directory account");
      cache.transaction(() => {
        const previous = account.get();
        if (previous && previous.id !== me.id) throw new Error("Directory account mismatch");
        const ids = [];
        for (const channel of channels.values()) {
          upsert.run(...channelValues(channel, me.id));
          ids.push(channel.id);
        }
        retain.run(JSON.stringify(ids));
        cache.retainChannels(ids);
        setAccount.run(me.id, me.username, Date.now());
      });
    },
    remove(id) {
      cache.transaction(() => {
        remove.run(id);
        cache.purgeChannel(id);
      });
    },
    list(filters = {}) {
      const snapshot = account.get();
      if (!snapshot) throw new Error("Conversation directory has not been synchronized");
      const { refreshedAt, ...me } = snapshot;
      return { account: me, refreshedAt, ...page(db, filters) };
    },
  };
}
