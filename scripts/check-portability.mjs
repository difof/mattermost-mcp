// Heuristic pre-publish gate for tracked worktree bytes, names and symlink targets.
// Diagnostics identify locations and categories, never matching private values.
// History and arbitrary personal/business identifiers require a separate review.
import { execFileSync } from "node:child_process";
import { isUtf8 } from "node:buffer";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const checks = [
  [
    "machine-specific user path",
    /(?:\/(?:home|Users)\/[^/\s"'\\<>]+(?:\/|(?=[\s"']|$))|\/root(?:\/|(?=[\s"']|$))|[A-Za-z]:\\+(?:Users|Documents and Settings)\\+[^\\\s"'<>]+(?:\\+|(?=[\s"']|$)))/,
  ],
  ["private workspace path", /\/workspace\/(?:scratch|uploads)\/[^\s"']+/],
  ["private key", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/],
  [
    "credential-like token",
    /\b(?:gh[pousr]_[A-Za-z0-9]{32,}|github_pat_[A-Za-z0-9_]{48,}|glpat-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{20,}|sk-(?:proj-|live_|test_)?[A-Za-z0-9_-]{24,})\b/,
  ],
  [
    "encoded authentication token",
    /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/,
  ],
];

function privatePath(path) {
  if (
    /(?:^|\/)(?:\.ssh|\.aws|\.gnupg|\.kube|\.pats|\.secrets)(?:\/|$)|(?:^|\/)\.env(?:\.[^/]+)?\//.test(
      path,
    )
  )
    return true;
  if (/(?:^|\/)(?:\.env|[^/]+\.env)\.(?:example|sample|template)$/.test(path)) return false;
  return /(?:^|\/)(?:\.env(?:\.[^/]+)?|service\.env|\.pats(?:\.[^/]+)?|(?:http|admin)[-_]token(?:\.[^/]+)?|(?:credentials|oauth-tokens|auth)\.json|id_(?:rsa|dsa|ecdsa|ed25519))$|\.(?:sqlite3?|db)(?:-(?:shm|wal|journal))?$|\.(?:key|p12|pfx|pem|zip|tgz|7z|tar(?:\.gz)?|log)$/i.test(
    path,
  );
}

function placeholder(value) {
  return (
    /^(?:test|fake|fixture|mock|dummy|example|sample|placeholder|sentinel|your)(?:$|[-_:])/i.test(
      value,
    ) || /^(?:<[^>]+>|[$][{][^}]+[}]|[$][A-Z_][A-Z0-9_]*|\*+|x+|\.{3})$/.test(value)
  );
}

function entropy(value) {
  const counts = new Map();
  for (const c of value) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts.values()].reduce((sum, n) => {
    const p = n / value.length;
    return sum - p * Math.log2(p);
  }, 0);
}

function secretLiteral(value) {
  if (placeholder(value) || value.length < 20 || /\s/.test(value)) return false;
  // Evaluate delimited chunks so descriptive fixture labels with repeated numeric
  // padding remain useful, while random PATs and base64 credentials are caught.
  return value.split(/[-_:]/).some((part) => part.length >= 20 && entropy(part) >= 3.5);
}

function exampleHost(host) {
  return /(?:^|\.)(?:localhost|example|invalid|test|example\.(?:com|org|net))$/i.test(host);
}

function concreteIP(value) {
  const ip = value.replace(/^\[|\]$/g, "");
  if (isIP(ip) === 4) {
    // Documentation ranges, loopback/bind addresses, the standard metadata
    // sentinel, and the upstream catalog's conventional LAN-gateway example.
    return (
      !/^(?:127\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/.test(ip) &&
      !["0.0.0.0", "255.255.255.255", "169.254.169.254", "192.168.0.1"].includes(ip)
    );
  }
  return isIP(ip) === 6 && !/^(?:::|::1|2001:db8(?::.*)?)$/i.test(ip);
}

function findings(text) {
  const result = new Map();
  const add = (label, index) => {
    if (!result.has(label)) result.set(label, text.slice(0, index).split("\n").length);
  };
  for (const [label, pattern] of checks) {
    const match = pattern.exec(text);
    if (match) add(label, match.index);
  }
  for (const match of text.matchAll(
    /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])|(?<![\w:])(?:[A-Fa-f0-9]{0,4}:){2,}[A-Fa-f0-9:.]*(?![\w:])/g,
  )) {
    if (concreteIP(match[0])) add("concrete network address", match.index);
  }
  for (const match of text.matchAll(/\b(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*\b/gi)) {
    const host = match[0];
    if (
      !exampleHost(host) &&
      (/\.(?:internal|local|lan|corp|home|localdomain)$/i.test(host) ||
        /(?:^|\.)(?:internal|intranet)[a-z0-9-]*\./i.test(host))
    )
      add("internal hostname", match.index);
  }
  for (const match of text.matchAll(
    /\b(?:MM_URL|MM_OPENCODE_URL)["']?\s*[:=]\s*["']?(https?:\/\/[^"' \r\n<>]+)/g,
  )) {
    try {
      const url = new URL(match[1]);
      if (!exampleHost(url.hostname) && !isIP(url.hostname.replace(/^\[|\]$/g, ""))) {
        add("concrete service endpoint", match.index);
      }
    } catch {
      // Interpolated expressions and documented placeholders are not endpoints.
    }
  }
  for (const match of text.matchAll(
    /\b(?:[A-Z_]*(?:TOKEN|PASSWORD|SECRET|(?:API_)?KEY)|(?:access|refresh|admin|client|api)?[_-]?(?:token|password|secret|key))["']?\s*[:=]\s*["']([^"'\r\n]+)["']/gi,
  )) {
    if (secretLiteral(match[1])) add("sensitive literal", match.index);
  }
  for (const match of text.matchAll(
    /\b[A-Z][A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|(?:API_)?KEY)\s*=\s*([A-Za-z0-9_+/.=-]{20,})(?=\s|$)/g,
  )) {
    if (secretLiteral(match[1])) add("sensitive literal", match.index);
  }
  for (const match of text.matchAll(/\b(?:Bearer|Basic)\s+([A-Za-z0-9_+/.=-]{20,})/g)) {
    if (secretLiteral(match[1])) add("literal authorization", match.index);
  }
  for (const match of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/([^/\s:@]+):([^/\s@]+)@/gi)) {
    if (secretLiteral(match[2])) add("credential in URL", match.index);
  }
  return [...result].map(([label, line]) => ({ label, line }));
}

const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
let issues = 0;
for (const [index, path] of paths.entries()) {
  const nameFindings = findings(path);
  const privateName = privatePath(path);
  // A filename can itself contain a credential or private hostname.
  const location =
    privateName || nameFindings.length
      ? "<tracked file #" + (index + 1) + ">"
      : JSON.stringify(path);
  const report = (label, line) => {
    process.stderr.write(location + (line ? ":" + line : "") + ": " + label + "\n");
    issues++;
  };
  if (privateName) report("local state, secret or archive filename");
  for (const finding of nameFindings) report(finding.label + " in filename");
  try {
    const stat = lstatSync(path);
    let bytes;
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(path, "utf8");
      const destination = relative(process.cwd(), resolve(dirname(path), target));
      if (
        isAbsolute(target) ||
        /^[A-Za-z]:[\\/]/.test(target) ||
        destination === ".." ||
        destination.startsWith("../")
      )
        report("non-portable symlink target");
      bytes = Buffer.from(target);
    } else if (stat.isFile()) {
      bytes = readFileSync(path);
      // No silent binary bypass, including renamed SQLite files, archives, NUL
      // padding and UTF-16. This source repository has no binary asset allowlist.
      if (!isUtf8(bytes) || bytes.some((value) => value < 32 && ![9, 10, 13].includes(value))) {
        report("binary or non-UTF-8 artifact");
      }
    } else {
      report("unsupported tracked file type");
      continue;
    }
    for (const { label, line } of findings(bytes.toString("utf8"))) report(label, line);
  } catch {
    report("cannot inspect tracked file");
  }
}
if (issues) process.exitCode = 1;
else
  process.stdout.write(
    "Checked " + paths.length + " tracked files for common privacy and portability leaks.\n",
  );
