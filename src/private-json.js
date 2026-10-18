// Persist secret-bearing JSON without exposing partial writes, permissive old
// file modes, or a destination symlink's target.
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function writePrivateJson(file, value) {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryDirectory = mkdtempSync(join(directory, ".private-json-"));
  try {
    const temporaryFile = join(temporaryDirectory, "data.json");
    writeFileSync(temporaryFile, json, { mode: 0o600 });
    renameSync(temporaryFile, file);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
