import { mkdtempSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { VERSION } from "./version.js";

it("prints help and version without loading the API catalog or runtime dependencies", () => {
  const directory = mkdtempSync(join(tmpdir(), "mattermost-cli-"));
  try {
    mkdirSync(join(directory, "src"));
    copyFileSync(new URL("../package.json", import.meta.url), join(directory, "package.json"));
    for (const name of ["index.js", "version.js", "log.js"]) {
      copyFileSync(new URL(name, import.meta.url), join(directory, "src", name));
    }
    for (const argument of ["--help", "--version"]) {
      const result = spawnSync(process.execPath, [join(directory, "src/index.js"), argument], {
        encoding: "utf8",
        timeout: 5000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(VERSION);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
