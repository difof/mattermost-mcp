import {
  accessSync,
  constants,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const name = "mattermost-mcp.service";
const source = new URL("../examples/" + name + ".in", import.meta.url);
const help = `Usage: node scripts/install-service.mjs [options]

  --launcher PATH      Absolute executable wrapper or binary; receives "serve"
  --node PATH          Node executable (default: the Node running this installer)
  --entry PATH         Built entry (default: this checkout's dist/index.js)
  --env-file PATH      Private environment file (default: XDG config/mattermost-mcp/service.env)
  --no-env-file        Wrapper supplies all required settings
  --print              Print the unit without installing
  --replace            Explicitly replace a different existing regular unit
  --help               Show usage

Installs only the unit under XDG config/systemd/user. Never creates credentials
or starts, stops, enables, or reloads systemd services.
`;

function absolute(value, label) {
  if (!isAbsolute(value) || /\p{Cc}/u.test(value))
    throw new Error(label + " must be an absolute path without control characters");
  return value;
}

function requireFile(file, access, label) {
  const stat = statSync(file);
  if (!stat.isFile()) throw new Error(label + " must be a regular file");
  accessSync(file, access);
  return stat;
}

function execWord(value) {
  // Unit command syntax, not shell quoting. ':' disables dollar expansion.
  return '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%") + '"';
}

function environmentLine(file) {
  absolute(file, "--env-file");
  // EnvironmentFile is one raw filename or glob, not a quoted ExecStart word.
  if (file.trimEnd() !== file || /[\\*?[\]{}]/u.test(file))
    throw new Error("--env-file cannot end in whitespace or contain glob or backslash characters");
  const stat = requireFile(file, constants.R_OK, "--env-file");
  if (stat.uid !== process.getuid() || stat.mode & 0o077)
    throw new Error("--env-file must belong to the current user and be owner-only (0600 or 0400)");
  return "EnvironmentFile=" + file.replaceAll("%", "%%");
}

function render(opts, configDir) {
  if (opts.launcher !== undefined && (opts.node !== undefined || opts.entry !== undefined))
    throw new Error("Choose --launcher or --node/--entry");
  if (opts["no-env-file"] && opts["env-file"] !== undefined)
    throw new Error("Choose --env-file or --no-env-file");
  const exe = absolute(opts.launcher ?? opts.node ?? process.execPath, "Executable");
  if (/[\\'"]/u.test(exe))
    throw new Error("systemd executable paths cannot contain quotes or backslashes");
  requireFile(exe, constants.X_OK, "Executable");
  const words = [execWord(exe)];
  if (opts.launcher === undefined) {
    const entry = absolute(
      opts.entry ?? fileURLToPath(new URL("../dist/index.js", import.meta.url)),
      "--entry",
    );
    requireFile(entry, constants.R_OK, "--entry");
    words.push(execWord(entry));
  }
  const env = opts["no-env-file"]
    ? ""
    : environmentLine(opts["env-file"] ?? join(configDir, "mattermost-mcp", "service.env"));
  const fields = { "@ENVIRONMENT_FILE@": env, "@EXEC_START@": ":" + words.join(" ") + " serve" };
  return readFileSync(source, "utf8").replace(
    /@ENVIRONMENT_FILE@|@EXEC_START@/g,
    (key) => fields[key],
  );
}

function install(target, contents, replace) {
  const directory = dirname(target);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const prior = lstatSync(target, { throwIfNoEntry: false });
  if (prior) {
    if (!prior.isFile() || prior.uid !== process.getuid())
      throw new Error(
        "Refusing to replace a symlink, special file, or another user's unit: " + target,
      );
    if (
      !(prior.mode & 0o077) &&
      prior.size === Buffer.byteLength(contents) &&
      readFileSync(target, "utf8") === contents
    )
      return "Already installed";
    if (!replace)
      throw new Error("Different unit exists; compare --print before using --replace: " + target);
  }
  const temp = mkdtempSync(join(directory, ".mattermost-unit-"));
  try {
    const file = join(temp, name);
    writeFileSync(file, contents, { flag: "wx", mode: 0o600 });
    // A fresh install must never clobber a concurrently created unit.
    if (prior) renameSync(file, target);
    else linkSync(file, target);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  return "Installed";
}

try {
  const { values } = parseArgs({
    options: {
      launcher: { type: "string" },
      node: { type: "string" },
      entry: { type: "string" },
      "env-file": { type: "string" },
      "no-env-file": { type: "boolean" },
      print: { type: "boolean" },
      replace: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) process.stdout.write(help);
  else {
    if (process.platform !== "linux") throw new Error("systemd user units require Linux");
    const config = absolute(
      process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
      "XDG_CONFIG_HOME",
    );
    const unit = render(values, config);
    if (values.print) process.stdout.write(unit);
    else {
      const target = join(config, "systemd", "user", name);
      process.stdout.write(install(target, unit, values.replace) + ": " + target + "\n");
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
