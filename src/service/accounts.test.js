import { afterEach, expect, it } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serviceRuntime } from "./runtime.js";
import { dispatchToolCall } from "../tools/registry.js";
import { allTools } from "../tools/index.js";
import { accountTools } from "../tools/accounts.js";

const cleanups = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture(defaultId = "alpha") {
  const dir = mkdtempSync(join(tmpdir(), "mm-accounts-")),
    uploads = join(dir, "uploads");
  mkdirSync(uploads, { mode: 0o700 });
  const identities = new Map([
      ["fixture-alpha", { id: "a".repeat(26), username: "alpha" }],
      ["fixture-beta", { id: "b".repeat(26), username: "beta" }],
      ["fixture-gamma", { id: "g".repeat(26), username: "gamma" }],
    ]),
    denied = new Set(),
    calls = [];
  const http = createServer(async (req, res) => {
    const token = req.headers.authorization?.replace(/^Bearer /i, "");
    calls.push({ token, url: req.url });
    if (!identities.has(token) || denied.has(token)) return res.writeHead(401).end("{}");
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/v4/users/me") return res.end(JSON.stringify(identities.get(token)));
    res.writeHead(404).end("{}");
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const url = "http://127.0.0.1:" + http.address().port,
    seed = join(dir, "seed.json");
  writeFileSync(
    seed,
    JSON.stringify({
      ...(defaultId ? { default_account_id: defaultId } : {}),
      accounts: [
        { id: "alpha", url, token: "fixture-alpha" },
        { id: "beta", url, token: "fixture-beta" },
      ],
    }),
    { mode: 0o600 },
  );
  const env = {
    MM_ACCOUNTS_FILE: seed,
    MM_EVENTS_STATE_DIR: join(dir, "state"),
    MM_SETTINGS_FILE: join(dir, "old-settings.json"),
    MM_HTTP_TOKEN: "fixture-http-bearer-12345678901234567890",
    MM_MAX_RETRIES: "0",
    MM_EVENTS_ENABLED: "false",
    MM_UPLOAD_ROOTS: JSON.stringify([uploads]),
  };
  let runtime;
  async function restart() {
    await runtime?.close();
    runtime = await serviceRuntime(env);
    await runtime.start();
  }
  cleanups.push(async () => {
    await runtime?.close();
    await new Promise((r) => http.close(r));
    http.closeAllConnections();
    rmSync(dir, { recursive: true, force: true });
  });
  await restart();
  async function call(name, args = {}) {
    const r = await dispatchToolCall(
      [...accountTools, ...allTools],
      { session: runtime.getSession() },
      name,
      args,
    );
    return r.isError ? { error: r.content[0].text } : JSON.parse(r.content[0].text);
  }
  return {
    dir,
    uploads,
    url,
    seed,
    env,
    identities,
    denied,
    calls,
    restart,
    call,
    get runtime() {
      return runtime;
    },
  };
}
it("pins interleaved requests to explicit accounts, preserves an operator default and never exposes credentials", async () => {
  const f = await fixture();
  const [a, b, c] = await Promise.all([
    f.call("get_me", { account_id: "alpha" }),
    f.call("get_me", { account_id: "beta" }),
    f.call("get_me"),
  ]);
  expect([a.username, b.username, c.username]).toEqual(["alpha", "beta", "alpha"]);
  const listing = await f.call("list_accounts");
  expect(listing.accounts.map((a) => a.account_id)).toEqual(["alpha", "beta"]);
  expect(JSON.stringify(listing)).not.toContain("fixture-");
  const before = f.calls.length;
  expect((await f.call("get_me", { account_id: "unknown" })).error).toMatch(/Unknown/);
  expect(f.calls).toHaveLength(before);
});
it("requires a selector without a default and retains database accounts after seed removal", async () => {
  const f = await fixture(null);
  expect((await f.call("get_me")).error).toMatch(/required/);
  rmSync(f.seed);
  f.env.MM_TOKEN = "different-legacy-token";
  await f.restart();
  expect((await f.call("get_me", { account_id: "beta" })).username).toBe("beta");
  expect((await f.call("get_me")).error).toMatch(/required/);
});
it("keeps healthy accounts usable when one credential fails on restart, and can explicitly recover it", async () => {
  const f = await fixture();
  f.denied.add("fixture-beta");
  await f.restart();
  expect((await f.call("get_me", { account_id: "alpha" })).username).toBe("alpha");
  expect((await f.call("get_me", { account_id: "beta" })).error).toMatch(/unavailable/);
  f.denied.clear();
  await f.runtime.admin.updateAccount("beta", { enabled: true });
  expect((await f.call("get_me", { account_id: "beta" })).username).toBe("beta");
  await f.runtime.admin.updateAccount("beta", { enabled: false });
  expect((await f.call("get_me", { account_id: "beta" })).error).toMatch(/disabled/);
});
it("adds accounts explicitly and rejects credential rotation to another identity without replacing the working account", async () => {
  const f = await fixture(),
    input = join(f.dir, "add.json");
  writeFileSync(input, JSON.stringify({ id: "gamma", url: f.url, token: "fixture-gamma" }), {
    mode: 0o600,
  });
  await f.runtime.admin.addAccount(input);
  expect((await f.call("get_me", { account_id: "gamma" })).username).toBe("gamma");
  writeFileSync(input, JSON.stringify({ id: "alpha", url: f.url, token: "fixture-beta" }), {
    mode: 0o600,
  });
  await expect(f.runtime.admin.rotateAccount("alpha", input)).rejects.toMatchObject({
    code: "ACCOUNT_MISMATCH",
  });
  expect((await f.call("get_me", { account_id: "alpha" })).username).toBe("alpha");
});
it("protects newly introduced credential inputs from already running account uploads even if activation fails", async () => {
  const f = await fixture(),
    source = join(f.uploads, "new-input.json");
  writeFileSync(source, JSON.stringify({ id: "gamma", url: f.url, token: "fixture-gamma" }), {
    mode: 0o600,
  });
  const lease = f.runtime.getSession().accounts.resolve("alpha"),
    access = lease.session.config.uploads.access;
  lease.release();
  expect(() => access.checkPath(source)).not.toThrow();
  await expect(f.runtime.admin.addAccount(source)).rejects.toThrow();
  expect(() => access.checkPath(source)).toThrow(/private/);
  await f.runtime.admin.reload(undefined, "alpha");
  rmSync(source);
  writeFileSync(source, "replacement secret", { mode: 0o600 });
  const renewed = f.runtime.getSession().accounts.resolve("alpha");
  try {
    expect(() => renewed.session.config.uploads.access.checkPath(source)).toThrow(/private/);
  } finally {
    renewed.release();
  }
  expect((await f.call("get_me", { account_id: "alpha" })).username).toBe("alpha");
});
