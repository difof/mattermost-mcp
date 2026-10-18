import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSourceCheckout } from "./mattermost-source.mjs";

const filename = "api/v4/source/example.yaml";
const trusted = Buffer.from("/api/v4/example:\n  get:\n    summary: Original operation\n");
const changed = Buffer.from("/api/v4/changed:\n  delete:\n    summary: Changed operation\n");
const manifest = { [filename]: createHash("sha256").update(trusted).digest("hex") };
let directory;
let revision;
const git = (...args) =>
  execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim();

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "mattermost-source-test-"));
  mkdirSync(dirname(join(directory, filename)), { recursive: true });
  writeFileSync(join(directory, filename), trusted);
  git("init", "--quiet");
  git("add", filename);
  git(
    "-c",
    "user.name=Source verification test",
    "-c",
    "user.email=source-test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "Disposable source fixture",
  );
  revision = git("rev-parse", "HEAD");
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("authenticated source checkouts", () => {
  it("reads the trusted bytes from an unchanged checkout", () => {
    expect(readSourceCheckout(directory, revision, manifest)).toEqual({ [filename]: trusted });
  });

  it.each(["--assume-unchanged", "--skip-worktree"])(
    "rejects modified bytes hidden from git status by %s",
    (flag) => {
      git("update-index", flag, filename);
      writeFileSync(join(directory, filename), changed);

      // Reproduce why the former revision + clean-status check was insufficient.
      expect(git("rev-parse", "HEAD")).toBe(revision);
      expect(git("status", "--porcelain", "--", "api/v4/source")).toBe("");
      expect(readFileSync(join(directory, filename))).toEqual(changed);
      expect(() => readSourceCheckout(directory, revision, manifest)).toThrow(
        `Source hash mismatch: ${filename}`,
      );
    },
  );

  it("still rejects ordinary checkout changes", () => {
    writeFileSync(join(directory, filename), changed);
    expect(() => readSourceCheckout(directory, revision, manifest)).toThrow(
      "Source API directories have changes or untracked files",
    );
  });

  it("rejects a different revision even when source bytes match", () => {
    expect(() => readSourceCheckout(directory, "0".repeat(40), manifest)).toThrow(
      "Source checkout must be exactly",
    );
  });
});
