import { cpSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = new URL("../dist/", import.meta.url);
rmSync(output, { recursive: true, force: true });
execFileSync(process.execPath, ["node_modules/typescript/bin/tsc"], {
  cwd: root,
  stdio: "inherit",
});
mkdirSync(new URL("api/", output), { recursive: true });
cpSync(new URL("../src/api/catalog.json", import.meta.url), new URL("api/catalog.json", output));
