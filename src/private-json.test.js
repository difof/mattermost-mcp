import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { writePrivateJson } from "./private-json.js";

it("preserves the destination and cleans temporary secrets when replacement fails", () => {
  const directory = mkdtempSync(join(tmpdir(), "mm-private-json-"));
  const occupied = join(directory, "occupied");
  mkdirSync(occupied);
  writeFileSync(join(occupied, "sentinel"), "unchanged");
  try {
    expect(() => writePrivateJson(occupied, { token: "dummy-token" })).toThrow();
    expect(readFileSync(join(occupied, "sentinel"), "utf8")).toBe("unchanged");
    expect(readdirSync(directory)).toEqual(["occupied"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
