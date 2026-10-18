#!/usr/bin/env node
// Generate the catalog from the independently audited immutable sources.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  COMMIT,
  VERSION,
  REPO_ROOT,
  sourceArguments,
  loadSource,
  loadSupplementalSource,
} from "./mattermost-source.mjs";
import { buildInventory, readOpenApi } from "./api-inventory.mjs";
import { buildCatalog } from "./api-catalog.mjs";

const print = (message) => process.stdout.write(`${message}\n`);
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

async function main() {
  const args = sourceArguments({
    inventory: { type: "string", default: join(REPO_ROOT, "docs/api-coverage.json") },
    output: { type: "string", default: join(REPO_ROOT, "src/api/catalog.json") },
  });
  if (args.help) {
    print(
      `Usage: node scripts/generate-api-catalog.mjs (--download | --source PATH | --cached-source PATH) [--cache PATH] [--inventory PATH] [--output PATH] [--check]\nSource: Mattermost v${VERSION}, commit ${COMMIT}. Run audit-api-coverage.mjs first. --check verifies immutable source, current inventory and catalog.`,
    );
    return;
  }
  const files = await loadSource(args);
  const extra = await loadSupplementalSource(args);
  const specs = readOpenApi(files);
  const inventory = buildInventory(files, { specs });
  if (!isDeepStrictEqual(readJson(args.inventory), inventory)) {
    throw new Error(
      "Inventory differs from pinned source/current tool mapping; regenerate audit-api-coverage.mjs first",
    );
  }
  const catalog = buildCatalog(specs, inventory, extra);
  if (args.check) {
    if (!isDeepStrictEqual(readJson(args.output), catalog))
      throw new Error(`Catalog differs: ${args.output}`);
    print("Catalog matches immutable source, current inventory and explicit corrections.");
  } else {
    mkdirSync(dirname(args.output), { recursive: true });
    writeFileSync(args.output, `${JSON.stringify(catalog, null, 2)}\n`);
  }
  print(
    JSON.stringify({
      operations: Object.keys(catalog.operations).length,
      account_callable: inventory.counts.generic_callable_routes,
      schemas: Object.keys(catalog.components.schemas).length,
      correction_groups: catalog.corrections.length,
    }),
  );
}

main().catch((error) => {
  console.error(`catalog generation failed: ${error.message}`);
  process.exitCode = 1;
});
