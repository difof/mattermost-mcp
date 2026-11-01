// Scan tracked files in CI; report locations, never matching contents.
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";

const privateFile =
  /(^|\/)(?:\.env(?:\..+)?|service\.env|\.pats|http-token|admin-token|[^/]+\.sqlite3?(?:-(?:shm|wal|journal))?)(?:\/|$)/;
const checks = [
  [
    "absolute user path",
    /(?:\/(?:home|Users)\/[A-Za-z0-9_.-]+\/|[A-Za-z]:\\+Users\\+[A-Za-z0-9_.-]+\\+)/,
  ],
  ["private workspace path", /\/workspace\/scratch\/[A-Za-z0-9_-]+(?:\/|$)/],
  ["private key", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/],
  [
    "credential-like token",
    /\b(?:gh[pousr]_[A-Za-z0-9]{32,}|github_pat_[A-Za-z0-9_]{48,}|AKIA[A-Z0-9]{16})\b/,
  ],
];

const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
let issues = 0;
function report(path, label) {
  process.stderr.write(path + ": " + label + "\n");
  issues++;
}
for (const path of paths) {
  if (privateFile.test(path) && !/(^|\/)\.env\.example$/.test(path))
    report(path, "local state or secret file");
  // Never follow a repository symlink into the build machine.
  const bytes = lstatSync(path).isSymbolicLink()
    ? Buffer.from(readlinkSync(path, "utf8"))
    : readFileSync(path);
  if (bytes.includes(0)) continue;
  const lines = bytes.toString("utf8").split("\n");
  for (const [label, pattern] of checks) {
    const line = lines.findIndex((text) => pattern.test(text));
    if (line !== -1) report(path + ":" + (line + 1), label);
  }
}
if (issues) process.exitCode = 1;
else
  process.stdout.write(
    "Checked " + paths.length + " tracked files for common portability and secret leaks.\n",
  );
