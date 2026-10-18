#!/usr/bin/env node
// Reproduce the pinned coverage inventory; never imported by the runtime.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { COMMIT, VERSION, REPO_ROOT, sourceArguments, loadSource } from "./mattermost-source.mjs";
import { buildInventory } from "./api-inventory.mjs";

const print = (message) => process.stdout.write(`${message}\n`);

async function main() {
  const args = sourceArguments({
    output: { type: "string", default: join(REPO_ROOT, "docs/api-coverage.json") },
  });
  if (args.help) {
    print(
      `Usage: node scripts/audit-api-coverage.mjs (--download | --source PATH | --cached-source PATH) [--cache PATH] [--output PATH] [--check]\nSource: Mattermost v${VERSION}, commit ${COMMIT}. --source requires a clean, hash-verified checkout; --cached-source verifies the pinned manifest offline.`,
    );
    return;
  }
  const inventory = buildInventory(await loadSource(args));
  if (args.check) {
    if (!isDeepStrictEqual(JSON.parse(readFileSync(args.output, "utf8")), inventory))
      throw new Error(`Inventory differs: ${args.output}`);
    print("Inventory matches pinned source and current tool mapping.");
  } else {
    mkdirSync(dirname(args.output), { recursive: true });
    writeFileSync(args.output, `${JSON.stringify(inventory, null, 2)}\n`);
  }
  print(JSON.stringify(inventory.counts, null, 2));
}

main().catch((error) => {
  console.error(`audit failed: ${error.message}`);
  process.exitCode = 1;
});
