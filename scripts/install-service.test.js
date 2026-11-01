import { afterEach, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./install-service.mjs", import.meta.url));
const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "mcp-systemd-"));
  dirs.push(dir);
  const config = join(dir, "config dir"),
    target = join(config, "systemd/user/mattermost-mcp.service");
  const launcher = join(dir, "run $name %f");
  const file = join(dir, "private config %n.env");
  symlinkSync(process.execPath, launcher);
  writeFileSync(file, "MM_TOKEN=secret-canary\n", { mode: 0o600 });
  const run = (...args) => {
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, XDG_CONFIG_HOME: config },
    });
    if (result.error) throw result.error;
    return result;
  };
  return { dir, config, target, launcher, file, run };
}

it.skipIf(process.platform !== "linux")(
  "renders literal argv and environment paths for systemd; installs idempotently without exposing credentials",
  () => {
    const { dir, config, target, launcher, file, run } = fixture();
    const args = ["--launcher", launcher, "--env-file", file];
    const preview = run(...args, "--print");
    expect(preview.status, preview.stderr).toBe(0);
    expect(existsSync(config)).toBe(false);
    expect(preview.stdout).toContain('ExecStart=:"' + dir + '/run $name %%f" serve');
    expect(preview.stdout).toContain("EnvironmentFile=" + file.replace("%", "%%"));
    expect(preview.stdout).not.toContain("secret-canary");
    expect(run(...args).status).toBe(0);
    expect(readFileSync(target, "utf8")).toBe(preview.stdout);
    expect(lstatSync(target).mode & 0o777).toBe(0o600);
    expect(run(...args).stdout).toMatch(/Already installed/);
    expect(readFileSync(file, "utf8")).toBe("MM_TOKEN=secret-canary\n");
    // Verify the parser's resolved file and argv without contacting a service manager.
    if (spawnSync("systemd-analyze", ["--version"]).status === 0) {
      const result = spawnSync("systemd-analyze", ["verify", "--man=no", target], {
        encoding: "utf8",
        env: { ...process.env, SYSTEMD_LOG_LEVEL: "debug" },
        maxBuffer: 4 * 1024 * 1024,
      });
      expect(result.status, result.stderr.slice(-2000)).toBe(0);
      expect(result.stdout + result.stderr).toContain("EnvironmentFile: " + file);
    }
  },
);

it.skipIf(process.platform !== "linux")(
  "supports explicit Node and entry paths; refuses unreviewed replacements, unsafe inputs and symlink destinations",
  () => {
    const { dir, target, launcher, file, run } = fixture();
    const entry = join(dir, "dist entry.js");
    writeFileSync(entry, "");
    const args = ["--node", launcher, "--entry", entry, "--no-env-file"];
    const preview = run(...args, "--print");
    expect(preview.status, preview.stderr).toBe(0);
    expect(preview.stdout).toContain('"' + entry + '" serve');
    expect(preview.stdout).not.toContain("EnvironmentFile=");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "custom unit\n", { mode: 0o600 });
    expect(run(...args).status).not.toBe(0);
    expect(readFileSync(target, "utf8")).toBe("custom unit\n");
    expect(run(...args, "--replace").status).toBe(0);
    expect(readFileSync(target, "utf8")).toBe(preview.stdout);
    rmSync(target);
    symlinkSync(file, target);
    expect(run(...args, "--replace").status).not.toBe(0);
    expect(readFileSync(file, "utf8")).toContain("secret-canary");
    chmodSync(file, 0o644);
    expect(run("--launcher", launcher, "--env-file", file, "--print").status).not.toBe(0);
    expect(
      run("--launcher", launcher + "\nRestart=always", "--no-env-file", "--print").status,
    ).not.toBe(0);
  },
);
