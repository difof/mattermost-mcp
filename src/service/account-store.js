import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { ServerUrlSchema } from "../config.js";
import { privateFile } from "../events/cache.js";
import { readSecretFile } from "./secret.js";
import { serviceError } from "./inputs.js";

export const accountId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const optionNames = [
  "MM_READ_ONLY",
  "MM_ALLOW_DESTRUCTIVE",
  "MM_TEAM_ALLOWLIST",
  "MM_CHANNEL_ALLOWLIST",
  "MM_MAX_MESSAGE_LEN",
  "MM_MAX_RESPONSE_BYTES",
  "MM_ALLOW_SENSITIVE_READS",
  "MM_CACHE_VERIFY_POSTS",
  "MM_UPLOAD_ROOTS",
  "MM_MAX_UPLOAD_BYTES",
  "MM_REQUEST_TIMEOUT_MS",
  "MM_MAX_RETRIES",
  "MM_RETRY_BASE_MS",
  "MM_RETENTION_HOURS",
  "MM_EVENTS_ENABLED",
];
const options = z
  .object(Object.fromEntries(optionNames.map((key) => [key, z.string().optional()])))
  .strict();
const accountInput = z
  .object({
    id: accountId,
    label: z.string().min(1).max(100).optional(),
    url: ServerUrlSchema,
    token: z.string().min(1).max(4096).optional(),
    token_file: z.string().refine(isAbsolute).optional(),
    token_line: z.number().int().positive().optional(),
    options: options.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (Boolean(v.token) === Boolean(v.token_file) || (v.token_line && !v.token_file))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Provide exactly one token source" });
  });
const seedInput = z
  .object({
    accounts: z.array(accountInput).min(1).max(32),
    default_account_id: accountId.optional(),
  })
  .strict();

export function accountDatabase(env = process.env) {
  const file =
    env.MM_ACCOUNTS_DB ||
    join(
      env.MM_EVENTS_STATE_DIR ||
        join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "mattermost-mcp"),
      "accounts.sqlite3",
    );
  if (!isAbsolute(file) || file.includes("\0")) throw serviceError("INVALID_SETTINGS");
  return file;
}
export const hasAccounts = (env) => !!env.MM_ACCOUNTS_FILE || existsSync(accountDatabase(env));

export function readAccountInput(file, base = {}) {
  let entry;
  try {
    entry = accountInput.parse(JSON.parse(readSecretFile(file)));
  } catch {
    throw serviceError("INVALID_CREDENTIALS");
  }
  const resolved = resolveInput(entry, base);
  resolved.privateFiles.push(file);
  return resolved;
}
function resolveInput(entry, base) {
  let token = entry.token;
  if (entry.token_file) {
    token = readSecretFile(entry.token_file);
    if (entry.token_line) token = token.split(/\r?\n/)[entry.token_line - 1]?.trim();
  }
  if (!token || /\s|\0/u.test(token)) throw serviceError("INVALID_CREDENTIALS");
  return {
    id: entry.id,
    label: entry.label || entry.id,
    url: entry.url,
    token,
    options: {
      ...Object.fromEntries(
        optionNames.filter((k) => base[k] !== undefined).map((k) => [k, base[k]]),
      ),
      ...entry.options,
    },
    privateFiles: entry.token_file ? [entry.token_file] : [],
  };
}
export function readAccountSeed(env) {
  let seed;
  try {
    seed = seedInput.parse(JSON.parse(readSecretFile(env.MM_ACCOUNTS_FILE)));
  } catch {
    throw serviceError("INVALID_CREDENTIALS");
  }
  if (
    new Set(seed.accounts.map((a) => a.id)).size !== seed.accounts.length ||
    (seed.default_account_id && !seed.accounts.some((a) => a.id === seed.default_account_id))
  )
    throw serviceError("INVALID_SETTINGS");
  return {
    accounts: seed.accounts.map((a) => resolveInput(a, env)),
    defaultId: seed.default_account_id ?? null,
  };
}
export function openAccounts(file) {
  const DatabaseSync = process.getBuiltinModule?.("node:sqlite")?.DatabaseSync;
  if (!DatabaseSync) throw new Error("Multi-account service requires Node.js 22.13+");
  privateFile(file);
  const db = new DatabaseSync(file);
  db.exec(
    "PRAGMA secure_delete=ON; PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=3000; PRAGMA trusted_schema=OFF",
  );
  if (db.prepare("PRAGMA user_version").get().user_version > 1) {
    db.close();
    throw new Error("Unsupported future account registry version");
  }
  db.exec(`CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY, label TEXT NOT NULL, url TEXT NOT NULL, user_id TEXT NOT NULL,
    username TEXT NOT NULL, token TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    options TEXT NOT NULL, private_files TEXT NOT NULL, UNIQUE(url,user_id)
  );
  CREATE TABLE IF NOT EXISTS account_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  PRAGMA user_version=1;`);
  const decode = (row) =>
    row && {
      ...row,
      userId: row.user_id,
      options: JSON.parse(row.options),
      privateFiles: JSON.parse(row.private_files),
    };
  const all = () => db.prepare("SELECT * FROM accounts ORDER BY id").all().map(decode);
  const revision = () => createHash("sha256").update(JSON.stringify(all())).digest("hex");
  function transaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  function put(a) {
    db.prepare(
      `INSERT INTO accounts(id,label,url,user_id,username,token,enabled,options,private_files)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,token=excluded.token,
      enabled=excluded.enabled,username=excluded.username,options=excluded.options,private_files=excluded.private_files`,
    ).run(
      a.id,
      a.label,
      a.url,
      a.userId,
      a.username,
      a.token,
      Number(a.enabled ?? true),
      JSON.stringify(a.options),
      JSON.stringify(a.privateFiles ?? []),
    );
  }
  return {
    all,
    revision,
    initialized: () => !!db.prepare("SELECT 1 FROM account_meta WHERE key='initialized'").get(),
    defaultId: () =>
      db.prepare("SELECT value FROM account_meta WHERE key='default'").get()?.value || null,
    get: (id) => decode(db.prepare("SELECT * FROM accounts WHERE id=?").get(id)),
    check(expected) {
      if (expected !== undefined && expected !== revision())
        throw serviceError("REVISION_CONFLICT");
    },
    seed(accounts, defaultId) {
      transaction(() => {
        if (db.prepare("SELECT 1 FROM account_meta WHERE key='initialized'").get())
          throw serviceError("REVISION_CONFLICT");
        for (const a of accounts) put(a);
        db.prepare("INSERT INTO account_meta VALUES('default',?)").run(defaultId || "");
        db.exec("INSERT INTO account_meta VALUES('initialized','1')");
      });
    },
    save: (a) => transaction(() => put(a)),
    close: () => db.close(),
  };
}
