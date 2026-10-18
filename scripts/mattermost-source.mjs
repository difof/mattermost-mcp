// Immutable Mattermost source inputs for the development-only audit and catalog.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const VERSION = "11.11.1";
export const COMMIT = "3acb3a7f684d11ccfcec4e5bd11c79f64e3eabf9";
export const REPOSITORY = "https://github.com/mattermost/mattermost";
const SOURCE_DIRS = ["api/v4/source", "server/channels/api4"];
// Authenticated by the immutable revision's Git blob IDs in the original audit.
// Pin the manifest itself so a modified inventory cannot approve its own cache.
const SOURCE_MANIFEST_SHA256 = "8dbfb570a95d5c03da3955c97be532423ed92bc60118f503fc2f11ef12a7d73c";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Supplemental sources used by the explicit corrections, all from the same
// immutable revision as the independently authenticated 149-file base audit.
const EXTRA_SOURCES = {
  "server/public/model/channel_join_request.go":
    "fc88cb8900da9f7ffb890ea7f4cb271ece0640d04ced3c40ea49e73625a7890d",
  "server/channels/app/channel_join_request.go":
    "01a1be0f15f19a0daa7eec8c3a29ee04d87af778d6e68313936a09be96b7f7b4",
  "server/channels/web/params.go":
    "b761869701e7807037a03aa4219384e2cd0bae06dd8d4fdebd2483b31053dfbe",
  "server/public/model/group_syncable.go":
    "5930f6cd2e46b604c59f7bc1665311e5c411d3800900c897d34d4395559f72b4",
  "server/public/model/integration_action.go":
    "e5840e59ed2d7d6d96e60e008b8f417928d0a6e4eefd6d4bf11d170e096093cc",
  "server/public/model/push_notification.go":
    "797ff3e676f8bb666a0111e2fadc1d204ae22d35a8daeea8a0222035accc0e17",
  "server/public/model/cloud.go":
    "12313744c6729f14dd7fbd8da9ed553c8d4b7ae50102f07f452e858f6369ea1a",
};

const digest = (data) => createHash("sha256").update(data).digest("hex");
const sortedEntries = (object) =>
  Object.entries(object).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const isSourceFile = (name) =>
  name.endsWith(".yaml") || (name.endsWith(".go") && !name.endsWith("_test.go"));

export function sourceHashes(files) {
  return Object.fromEntries(sortedEntries(files).map(([name, data]) => [name, digest(data)]));
}

function pinnedManifest() {
  const metadata = JSON.parse(
    readFileSync(join(REPO_ROOT, "docs/api-coverage.json"), "utf8"),
  ).source;
  const manifest = metadata.source_sha256;
  if (
    metadata.commit !== COMMIT ||
    digest(JSON.stringify(Object.fromEntries(sortedEntries(manifest)))) !== SOURCE_MANIFEST_SHA256
  ) {
    throw new Error("Cached source manifest differs from the pinned, authenticated audit");
  }
  return manifest;
}

function verifiedFiles(directory, manifest) {
  return Object.fromEntries(
    Object.entries(manifest).map(([name, hash]) => {
      const data = readFileSync(join(directory, name));
      if (digest(data) !== hash) throw new Error(`Source hash mismatch: ${name}`);
      return [name, data];
    }),
  );
}

async function request(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "mattermost-mcp-api-coverage-audit" },
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`Source request failed: HTTP ${response.status} ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function downloadSource(cache) {
  const entries = [];
  for (const directory of SOURCE_DIRS) {
    const url = `https://api.github.com/repos/mattermost/mattermost/contents/${directory}?ref=${COMMIT}`;
    for (const entry of JSON.parse((await request(url)).toString("utf8"))) {
      if (entry.type === "file" && isSourceFile(entry.name)) entries.push(entry);
    }
  }
  const results = new Array(entries.length);
  let next = 0;
  // Source downloads are independent; cap concurrency and keep deterministic
  // ordering regardless of completion order.
  await Promise.all(
    Array.from({ length: Math.min(8, entries.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= entries.length) return;
        const entry = entries[index];
        const target = join(cache, entry.path);
        let data = existsSync(target) ? readFileSync(target) : Buffer.alloc(0);
        const correctBlob = (content) =>
          createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex") ===
          entry.sha;
        if (!correctBlob(data)) {
          data = await request(
            `https://raw.githubusercontent.com/mattermost/mattermost/${COMMIT}/${entry.path}`,
          );
          if (!correctBlob(data)) throw new Error(`Git blob mismatch: ${entry.path}`);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, data);
        }
        results[index] = [entry.path, data];
      }
    }),
  );
  return Object.fromEntries(results);
}

function git(source, ...args) {
  return execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
}

// Revision and manifest are trusted inputs; the CLI always uses the pins above.
// Checking actual bytes also catches changes hidden by Git's index flags.
export function readSourceCheckout(source, revision, manifest) {
  if (git(source, "rev-parse", "HEAD") !== revision) {
    throw new Error(`Source checkout must be exactly ${revision}`);
  }
  if (git(source, "status", "--porcelain", "--", ...SOURCE_DIRS)) {
    throw new Error("Source API directories have changes or untracked files");
  }
  return verifiedFiles(source, manifest);
}

export async function loadSupplementalSource(args) {
  const directory = args.source ?? args["cached-source"] ?? args.cache;
  const download = !!args.download;
  const checkout = !!args.source;
  if (checkout && git(directory, "status", "--porcelain", "--", ...Object.keys(EXTRA_SOURCES))) {
    throw new Error("Supplemental source files have checkout changes");
  }
  const files = await Promise.all(
    Object.entries(EXTRA_SOURCES).map(async ([name, expected]) => {
      const target = join(directory, name);
      let data = existsSync(target) ? readFileSync(target) : Buffer.alloc(0);
      if (digest(data) !== expected && download) {
        data = await request(
          `https://raw.githubusercontent.com/mattermost/mattermost/${COMMIT}/${name}`,
        );
        if (digest(data) === expected) {
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, data);
        }
      }
      if (digest(data) !== expected)
        throw new Error(`Supplemental source hash mismatch or missing file: ${name}`);
      return [name, data];
    }),
  );
  return Object.fromEntries(files);
}

export function sourceArguments(extra = {}) {
  const { values } = parseArgs({
    options: {
      source: { type: "string" },
      download: { type: "boolean" },
      "cached-source": { type: "string" },
      cache: { type: "string", default: "/tmp/mattermost-v11-api-audit" },
      check: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
      ...extra,
    },
  });
  if (
    !values.help &&
    [values.source, values.download, values["cached-source"]].filter(Boolean).length !== 1
  ) {
    throw new Error("Choose exactly one of --source, --download or --cached-source");
  }
  return values;
}

export async function loadSource(args) {
  if (args.source) return readSourceCheckout(args.source, COMMIT, pinnedManifest());
  if (args["cached-source"]) return verifiedFiles(args["cached-source"], pinnedManifest());
  return downloadSource(args.cache);
}
