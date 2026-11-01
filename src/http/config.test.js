import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { httpSettings } from "./config.js";

it("requires one independent, private HTTP bearer source and rejects invalid service settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-http-token-"));
  try {
    const file = join(dir, "token");
    const token = "a".repeat(48);
    writeFileSync(file, token + "\n", { mode: 0o600 });
    expect(httpSettings({ MM_HTTP_TOKEN_FILE: file }).token).toBe(token);
    expect(() => httpSettings({ MM_HTTP_TOKEN_FILE: file, MM_HTTP_TOKEN: token })).toThrow(
      /exactly one/,
    );
    if (process.platform !== "win32") {
      chmodSync(file, 0o644);
      expect(() => httpSettings({ MM_HTTP_TOKEN_FILE: file })).toThrow(/private/);
    }
    expect(() => httpSettings({ MM_HTTP_TOKEN: "short" })).toThrow(/32/);
    for (const extra of [
      { MM_HTTP_PORT: "0" },
      { MM_HTTP_MAX_BODY_BYTES: "-1" },
      { MM_EVENTS_ENABLED: "yes" },
    ]) {
      expect(() => httpSettings({ MM_HTTP_TOKEN: token, ...extra })).toThrow();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
