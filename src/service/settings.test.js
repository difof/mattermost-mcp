import { afterEach, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  statSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapSettings,
  effectiveSettings,
  patchOverrides,
  readOverrides,
  settingsFile,
  writeOverrides,
} from "./settings.js";

const dirs = [];
function temporary() {
  const dir = mkdtempSync(join(tmpdir(), "mm-managed-"));
  dirs.push(dir);
  return join(dir, "settings.json");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const bootstrap = (env = {}) =>
  bootstrapSettings(
    {
      guardrails: { readOnly: false, allowDestructive: false, maxMessageLen: 1200 },
      uploads: { maxBytes: 7000 },
      resilience: { timeoutMs: 10000, maxRetries: 2, baseDelayMs: 500 },
    },
    { maxBodyBytes: 42000, eventsEnabled: true, port: 9100 },
    env,
  );

it("persists typed overrides privately, resets individual keys and inherits later bootstrap values", () => {
  const file = temporary(),
    initial = readOverrides(file),
    defaults = bootstrap();
  const next = writeOverrides(
    file,
    patchOverrides(initial.overrides, {
      allow_destructive: true,
      read_only: true,
      retention_hours: 72,
      http_port: 8767,
    }),
    initial.revision,
  );
  expect(next.revision).toMatch(/^[0-9a-f]{64}$/);
  expect(readOverrides(file)).toEqual(next);
  expect(effectiveSettings(defaults, next.overrides)).toMatchObject({
    http_port: 8767,
    retention_hours: 72,
    read_only: true,
    max_message_len: 1200,
  });
  const reset = writeOverrides(
    file,
    patchOverrides(next.overrides, { retention_hours: null }),
    next.revision,
  );
  expect(JSON.parse(readFileSync(file))).toEqual({
    allow_destructive: true,
    http_port: 8767,
    read_only: true,
  });
  expect(
    effectiveSettings(bootstrap({ MM_RETENTION_HOURS: "36" }), reset.overrides).retention_hours,
  ).toBe(36);
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

it("refuses stale revisions and preserves newer or malformed edits on disk", () => {
  const file = temporary(),
    first = readOverrides(file);
  const set = writeOverrides(file, { retention_hours: 64, events_enabled: true }, first.revision);
  writeFileSync(file, '{"events_enabled":true, "retention_hours":64}');
  expect(readOverrides(file).revision).toBe(set.revision); // formatting/order don't change values
  writeFileSync(file, '{"retention_hours":96}');
  expect(() => writeOverrides(file, { read_only: true }, set.revision)).toThrow(
    expect.objectContaining({ code: "REVISION_CONFLICT" }),
  );
  expect(readOverrides(file).overrides).toEqual({ retention_hours: 96 });
  writeFileSync(file, '{"secret-not-for-errors":');
  expect(() => writeOverrides(file, {}, first.revision)).toThrow(
    expect.objectContaining({ code: "INVALID_SETTINGS", message: "Invalid settings file JSON" }),
  );
  expect(readFileSync(file, "utf8")).toBe('{"secret-not-for-errors":');
});

it("rejects unknown keys, secrets, coercions and bounds without including user-supplied literals in errors", () => {
  for (const patch of [
    {},
    { retention_hours: 169 },
    { retention_hours: 0 },
    { read_only: "false" },
    { max_retries: -1 },
    { http_port: 65536 },
    { http_max_body_bytes: 256 * 1024 * 1024 + 1 },
    { max_upload_bytes: 1.5 },
    { read_only: true, private_test_literal: "confidential-value" },
  ]) {
    expect(() => patchOverrides({}, patch)).toThrow(
      expect.objectContaining({ code: "INVALID_SETTINGS" }),
    );
  }
  expect(() => patchOverrides({}, { private_test_literal: "confidential-value" })).toThrow(
    /^Invalid settings patch$/,
  );
  expect(() => bootstrap({ MM_RETENTION_HOURS: "72x" })).toThrow(/retention_hours/);
  expect(settingsFile({ XDG_STATE_HOME: "/example/state" })).toBe(
    "/example/state/mattermost-mcp/settings.json",
  );
  expect(() => settingsFile({ MM_SETTINGS_FILE: "relative/settings.json" })).toThrow(/absolute/);
});

it("won't replace symlinks or loosen privacy on an unsafe existing settings file", () => {
  const file = temporary(),
    link = file + ".link";
  writeFileSync(file, '{"events_enabled":true}', { mode: 0o600 });
  const revision = readOverrides(file).revision;
  symlinkSync(file, link);
  expect(() => writeOverrides(link, {}, revision)).toThrow(
    expect.objectContaining({ code: "INVALID_SETTINGS" }),
  );
  chmodSync(file, 0o644);
  expect(() => writeOverrides(file, {}, revision)).toThrow(/owner-only/);
  expect(JSON.parse(readFileSync(file))).toEqual({ events_enabled: true });
});
