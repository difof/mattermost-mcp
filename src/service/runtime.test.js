import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOverrides } from "./settings.js";
import { serviceRuntime } from "./runtime.js";

const controls = vi.hoisted(() => ({ fail: false, starts: 0, stops: 0 }));
vi.mock("../mattermost/client.js", () => ({
  createSession: async (config) => ({ config, userId: "test-user", client: {} }),
}));
vi.mock("../events/index.js", () => ({
  startEvents: async ({ session, deferActivation }) => {
    const activate = async () => {
      if (deferActivation && controls.fail) throw new Error("activation failed");
      session.cache = {};
      controls.starts++;
    };
    if (!deferActivation) await activate();
    const stop = async () => {
      if (session.cache) {
        delete session.cache;
        controls.stops++;
      }
    };
    stop.activate = activate;
    return stop;
  },
}));
const dirs = [],
  services = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  Object.assign(controls, { fail: false, starts: 0, stops: 0 });
});
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "mm-runtime-"));
  dirs.push(dir);
  const file = join(dir, "settings.json");
  const runtime = await serviceRuntime({
    MM_URL: "https://mattermost.example",
    MM_AUTH_MODE: "pat",
    MM_TOKEN: "fixture-pat",
    MM_HTTP_TOKEN: "x".repeat(42),
    MM_EVENTS_ENABLED: "true",
    MM_SETTINGS_FILE: file,
    MM_EVENTS_STATE_DIR: dir,
  });
  services.push(runtime);
  await runtime.start();
  return { runtime, file };
}
it("drains requests before activating a new policy, without restarting unaffected subscriptions", async () => {
  const { runtime } = await fixture();
  const lease = runtime.getSession.acquire();
  const pending = runtime.admin.set({ max_message_len: 50 });
  await vi.waitFor(() => expect(runtime.getSession()).toBeNull());
  expect(lease.session.config.guardrails.maxMessageLen).not.toBe(50);
  expect(() => runtime.admin.set({ read_only: true })).toThrow("BUSY");
  lease.release();
  const result = await pending;
  expect(result.settings.max_message_len.value).toBe(50);
  expect(runtime.getSession().config.guardrails.maxMessageLen).toBe(50);
  expect(controls.starts).toBe(1);
  expect(controls.stops).toBe(0);
});
it("rolls back the persisted override and restores the prior active listener after activation fails", async () => {
  const { runtime, file } = await fixture();
  const old = runtime.admin.list();
  controls.fail = true;
  await expect(runtime.admin.set({ retention_hours: 2 }, old.revision)).rejects.toThrow();
  expect(readOverrides(file)).toEqual({ overrides: {}, revision: old.revision });
  expect(runtime.admin.list().settings.retention_hours.value).toBe(48);
  expect(runtime.getSession().cache).toBeDefined();
  expect(controls.starts).toBe(2);
});
it("does not overwrite an external edit made while a management operation waits for admission", async () => {
  const { runtime, file } = await fixture();
  const lease = runtime.getSession.acquire();
  const p = runtime.admin.set({ read_only: true });
  await vi.waitFor(() => expect(runtime.getSession()).toBeNull());
  writeFileSync(file, JSON.stringify({ max_retries: 2 }), { mode: 0o600 });
  lease.release();
  await expect(p).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  expect(readOverrides(file).overrides).toEqual({ max_retries: 2 });
  expect(runtime.getSession().config.guardrails.readOnly).toBe(false);
});
