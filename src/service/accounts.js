import { addProtectedUploadFiles } from "../mattermost/upload-access.js";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createSession } from "../mattermost/client.js";
import { loadConfig } from "../config.js";
import { httpSettings } from "../http/config.js";
import { writePrivateJson } from "../private-json.js";
import { readOverrides, settingsFile } from "./settings.js";
import { requestGate } from "./request-gate.js";
import { singleAccountRuntime } from "./runtime.js";
import { serviceError, verifyUser } from "./inputs.js";
import {
  accountDatabase,
  openAccounts,
  readAccountInput,
  readAccountSeed,
} from "./account-store.js";

const authKeys = [
  "MM_TOKEN",
  "MM_TOKEN_FILE",
  "MM_TOKEN_FILE_LINE",
  "MM_PASSWORD",
  "MM_LOGIN_ID",
  "MM_MFA_TOKEN",
  "MM_CLIENT_ID",
  "MM_CLIENT_SECRET",
  "MM_OAUTH_REDIRECT",
];
function accountEnv(env, account, file, all) {
  const next = { ...env, ...account.options };
  for (const k of authKeys) delete next[k];
  next.MM_ACCOUNT_ID = account.id;
  next.MM_EXPECTED_USER_ID = account.userId || "";
  next.MM_URL = account.url;
  next.MM_TOKEN = account.token;
  next.MM_AUTH_MODE = "pat";
  next.MM_SETTINGS_FILE = join(dirname(file), "account-settings", account.id + ".json");
  next.MM_PRIVATE_ACCOUNT_FILES = JSON.stringify(all.flatMap((a) => a.privateFiles || []));
  return next;
}
async function verify(account, env, file, all) {
  let identity;
  await createSession(loadConfig(accountEnv(env, account, file, all)), {
    verify: async (client) => (identity = await verifyUser(client)),
  });
  return { ...account, userId: identity.id, username: identity.username };
}

export async function multiAccountRuntime(env) {
  const file = accountDatabase(env),
    store = openAccounts(file),
    runtimes = new Map(),
    failures = new Map();
  let ready = false,
    closed = false,
    pending;
  let http = httpSettings(env);
  try {
    if (!store.initialized()) {
      const seed = readAccountSeed(env),
        verified = [];
      for (const entry of seed.accounts)
        verified.push(await verify(entry, env, file, seed.accounts));
      store.seed(verified, seed.defaultId);
    }
    const accounts = store.all();
    // Import existing non-secret settings once; cache scope paths are unchanged.
    const legacy = readOverrides(settingsFile(env)).overrides;
    for (const account of accounts) {
      const next = accountEnv(env, account, file, accounts);
      if (!existsSync(next.MM_SETTINGS_FILE))
        writePrivateJson(
          next.MM_SETTINGS_FILE,
          account.id === (store.defaultId() ?? (accounts.length === 1 ? accounts[0].id : null))
            ? legacy
            : {},
        );
      if (account.enabled) {
        try {
          runtimes.set(account.id, await singleAccountRuntime(next));
        } catch {
          failures.set(account.id, "authentication_or_configuration");
        }
      }
    }
  } catch (error) {
    store.close();
    throw error;
  }
  http = runtimes.get(store.defaultId())?.http ?? http;
  function protect(files) {
    for (const runtime of runtimes.values())
      addProtectedUploadFiles(runtime.getSession()?.config.uploads?.access, files);
  }
  const facade = {
    config: {
      guardrails: {
        readOnly: true,
        allowDestructive: false,
        teamAllowlist: [],
        channelAllowlist: [],
        maxMessageLen: 16383,
      },
      maxResponseBytes: Math.max(
        8 * 1024 * 1024,
        ...[...runtimes.values()].map((r) => r.http.maxBodyBytes),
      ),
    },
    cache: true,
    accounts: {
      list: () => ({
        revision: store.revision(),
        default_account_id: store.defaultId(),
        accounts: store.all().map((a) => {
          const s = runtimes.get(a.id)?.getSession();
          return {
            account_id: a.id,
            label: a.label,
            url: a.url,
            user_id: a.userId,
            username: a.username,
            enabled: !!a.enabled,
            status: failures.get(a.id) || (s ? "ready" : a.enabled ? "starting" : "disabled"),
            sync_state: s?.cacheStatus,
            checkpoint_at: s?.cache?.getCheckpoint() ?? null,
          };
        }),
      }),
      resolve: (id) => {
        const all = store.all(),
          selected = id ?? store.defaultId() ?? (all.length === 1 ? all[0].id : null);
        if (!selected) throw new Error("account_id is required; use list_accounts");
        const account = all.find((a) => a.id === selected);
        if (!account) throw new Error("Unknown account_id");
        if (!account.enabled) throw new Error("Selected account is disabled");
        const lease = runtimes.get(selected)?.getSession.acquire();
        if (!lease) throw new Error("Selected account is unavailable");
        lease.session.accountId = selected;
        return lease;
      },
    },
  };
  const gate = requestGate(() => (ready ? facade : null));
  function selected(id) {
    const lease = facade.accounts.resolve(id);
    lease.release();
    return runtimes.get(lease.session.accountId);
  }
  async function update(run) {
    if (pending || closed || !ready) throw serviceError("BUSY");
    pending = (async () => {
      await gate.pause();
      try {
        return await run();
      } finally {
        gate.resume();
      }
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  }
  const admin = {
    list: (id) => ({ ...selected(id).admin.list(), account_registry: facade.accounts.list() }),
    set: (patch, expected, id) => selected(id).admin.set(patch, expected),
    reload: (expected, id) => selected(id).admin.reload(expected),
    listAccounts: facade.accounts.list,
    addAccount: (source, expected) =>
      update(async () => {
        store.check(expected);
        const entry = readAccountInput(source, env);
        protect(entry.privateFiles);
        if (store.get(entry.id)) throw serviceError("ACCOUNT_MISMATCH");
        const verified = await verify(entry, env, file, [...store.all(), entry]);
        if (store.all().some((a) => a.url === verified.url && a.userId === verified.userId))
          throw serviceError("ACCOUNT_MISMATCH");
        const next = await singleAccountRuntime(
          accountEnv(env, verified, file, [...store.all(), verified]),
        );
        try {
          await next.start();
          store.save(verified);
          runtimes.set(entry.id, next);
        } catch (error) {
          await next.close();
          throw error;
        }
        return facade.accounts.list();
      }),
    updateAccount: (id, patch, expected) =>
      update(async () => {
        store.check(expected);
        const prior = store.get(id);
        if (!prior) throw serviceError("INVALID_SETTINGS");
        const next = { ...prior, ...patch };
        if (patch.enabled === true && !runtimes.has(id)) {
          const rt = await singleAccountRuntime(accountEnv(env, next, file, store.all()));
          try {
            await rt.start();
            store.save(next);
            runtimes.set(id, rt);
            failures.delete(id);
          } catch (error) {
            await rt.close();
            throw error;
          }
        } else {
          store.save(next);
          if (patch.enabled === false) {
            const old = runtimes.get(id);
            runtimes.delete(id);
            await old?.close();
            failures.delete(id);
          }
        }
        return facade.accounts.list();
      }),
    rotateAccount: (id, source, expected) =>
      update(async () => {
        store.check(expected);
        const prior = store.get(id),
          entry = readAccountInput(source, env);
        protect(entry.privateFiles);
        if (!prior || entry.id !== id || entry.url !== prior.url)
          throw serviceError("ACCOUNT_MISMATCH");
        const verified = await verify(entry, env, file, [...store.all(), entry]);
        if (verified.userId !== prior.userId) throw serviceError("ACCOUNT_MISMATCH");
        const next = {
          ...prior,
          token: verified.token,
          privateFiles: [...new Set([...prior.privateFiles, ...verified.privateFiles])],
        };
        const candidate = prior.enabled
          ? await singleAccountRuntime(accountEnv(env, next, file, store.all()))
          : null;
        const old = runtimes.get(id);
        runtimes.delete(id);
        await old?.close();
        try {
          await candidate?.start();
          store.save(next);
          if (candidate) runtimes.set(id, candidate);
          failures.delete(id);
        } catch (error) {
          await candidate?.close();
          if (prior.enabled) {
            const restore = await singleAccountRuntime(accountEnv(env, prior, file, store.all()));
            await restore.start();
            runtimes.set(id, restore);
          }
          throw error;
        }
        return facade.accounts.list();
      }),
  };
  return {
    http,
    getSession: gate,
    admin,
    async start() {
      for (const [id, runtime] of runtimes) {
        try {
          await runtime.start();
          runtime.getSession().accountId = id;
        } catch {
          await runtime.close();
          runtimes.delete(id);
          failures.set(id, "listener_or_storage");
        }
      }
      ready = true;
    },
    async close() {
      closed = true;
      await pending?.catch(() => {});
      ready = false;
      await Promise.allSettled([...runtimes.values()].map((r) => r.close()));
      store.close();
    },
  };
}
