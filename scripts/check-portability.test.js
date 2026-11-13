import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";

const checker = fileURLToPath(new URL("./check-portability.mjs", import.meta.url));
const pat = "a1B2c3D4e5F6g7H8i9J0k1L2m3N";
const githubToken = "gh" + "p_" + pat + pat;
let directory;
let env;
function git(...args) {
  execFileSync("git", ["-C", directory, ...args], { env, stdio: "pipe" });
}
function tracked(path, contents) {
  const file = join(directory, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
  git("add", "--force", "--", path);
}
function scan() {
  return spawnSync(process.execPath, [checker], {
    cwd: directory,
    env,
    encoding: "utf8",
    timeout: 10000,
  });
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "mm-portability-test-"));
  env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[name];
  git("init", "--quiet");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

it("accepts portable examples, synthetic credentials, public references and relative links", () => {
  tracked(
    ".env.example",
    [
      "MM_URL=https://mattermost.example",
      "MM_OPENCODE_URL=http://127.0.0.1:4096",
      "MM_TOKEN=<your-token>",
      "MM_HTTP_TOKEN=fixture-credential-12345678901234567890",
    ].join("\n"),
  );
  tracked(
    "README.md",
    [
      "$HOME/dev/project /absolute/path/to/project",
      "https://docs.mattermost.com/ https://internal.example.com/",
      "http://localhost/ https://service.invalid/ https://agent.test/",
      "192.0.2.1 198.51.100.22 203.0.113.44 127.0.0.2 0.0.0.0",
      "169.254.169.254 192.168.0.1 ::1 2001:db8::8",
      'token: "personal-token", adminToken: "first-admin-token-123456789012345678901"',
    ].join("\n"),
  );
  mkdirSync(join(directory, "docs"));
  symlinkSync("../README.md", join(directory, "docs", "readme"));
  git("add", "--", "docs/readme");
  const result = scan();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("Checked 3 tracked files");
});

it.each([
  ["machine-specific user path", () => ["", "home", "fixture-operator"].join("/")],
  ["machine-specific user path", () => ["", "home", "fixture-operator", "project", ""].join("/")],
  [
    "machine-specific user path",
    () => ["C:", "Users", "fixture-operator", "project", ""].join("\\"),
  ],
  ["private workspace path", () => ["", "workspace", "scratch", "fixture-task", "file"].join("/")],
  ["internal hostname", () => ["fixture-node", "internal"].join(".")],
  [
    "concrete service endpoint",
    () => "MM_URL=https://" + ["chat", "fixture-tenant", "tld"].join("."),
  ],
  ["concrete network address", () => [10, 23, 45, 67].join(".")],
  ["concrete network address", () => ["fdab", "1234", "", "99"].join(":")],
  ["credential-like token", () => githubToken],
  ["sensitive literal", () => 'MM_TOKEN="' + pat + '"'],
  ["sensitive literal", () => "MM_TOKEN=" + pat],
  ["sensitive literal", () => "AWS_SECRET_ACCESS_KEY=" + pat],
  ["literal authorization", () => "Authorization: Bearer " + pat],
  [
    "literal authorization",
    () => "Authorization: Basic " + Buffer.from("fixture:" + pat).toString("base64"),
  ],
  ["credential in URL", () => "https://fixture:" + pat + "@example.invalid/api"],
  ["private key", () => ["-----BEGIN", "PRIVATE KEY-----"].join(" ")],
])("rejects %s without echoing the private match", (label, value) => {
  const text = value();
  tracked("notes.txt", "safe heading\n" + text + "\n");
  const result = scan();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('"notes.txt":2: ' + label);
  expect(result.stderr).not.toContain(text);
  expect(result.stderr).not.toContain(pat);
});

it.each([".env", "account.sqlite3", "credentials.json", "id_ed25519", "capture.zip"])(
  "rejects private artifact name %s even when empty",
  (filename) => {
    tracked(filename, "");
    const result = scan();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("<tracked file #1>: local state, secret or archive filename");
    expect(result.stderr).not.toContain(filename);
  },
);

it("rejects opaque files nested inside standard private directories", () => {
  tracked(".pats/opaque-note", "safe-looking content");
  tracked(".ssh/opaque-key", "safe-looking content");
  tracked(".aws/.env.example", "safe-looking content");
  const result = scan();
  expect(result.status).toBe(1);
  expect(result.stderr.match(/local state, secret or archive filename/g)).toHaveLength(3);
  expect(result.stderr).not.toContain("opaque-note");
});

it("redacts a credential embedded in a tracked filename", () => {
  tracked(githubToken + ".txt", "safe content");
  const result = scan();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("<tracked file #1>: credential-like token in filename");
  expect(result.stderr).not.toContain(githubToken);
});

it.each([
  () => Buffer.concat([Buffer.from("prefix\0"), Buffer.from(githubToken)]),
  () => Buffer.from(githubToken, "utf16le"),
  () => Buffer.from([255, 254, 1, 2, 3]),
])("rejects binary or encoded artifacts regardless of filename", (bytes) => {
  tracked("innocent.txt", bytes());
  const result = scan();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("binary or non-UTF-8 artifact");
  expect(result.stderr).not.toContain(githubToken);
});

it("checks symlink targets without reading the destination", () => {
  const secret = join(directory, "untracked-secret");
  writeFileSync(secret, githubToken);
  symlinkSync(secret, join(directory, "absolute-link"));
  symlinkSync("../../outside", join(directory, "escaping-link"));
  git("add", "--", "absolute-link", "escaping-link");
  const result = scan();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("non-portable symlink target");
  expect(result.stderr).not.toContain(githubToken);
  expect(result.stderr).not.toContain("credential-like token");
});

it("scans current tracked bytes even when Git status hides a modification", () => {
  tracked("notes.txt", "safe");
  git("update-index", "--assume-unchanged", "notes.txt");
  writeFileSync(join(directory, "notes.txt"), githubToken);
  const result = scan();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("credential-like token");
});
