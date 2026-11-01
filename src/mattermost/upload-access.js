// Paths are operator inputs. Store a snapshot of directory identities, not just
// their names; an upload must still resolve inside one of those same directories.
import { realpathSync, statSync } from "node:fs";
import { dirname, basename, resolve, join, relative, isAbsolute, sep } from "node:path";
import { homedir } from "node:os";
import { configDir, credentialsFile } from "../paths.js";

const policies = new WeakMap();

// A credential reload may rotate files; it must not reauthorize a replaced
// upload directory or forget an older credential still reachable by an alias.
export function inheritUploadProtection(previous, next) {
  const old = policies.get(previous),
    current = policies.get(next);
  if (!old || !current) return;
  if (old.rootIdentities !== current.rootIdentities) {
    throw Object.assign(new Error("Upload roots changed; restart with verified directories"), {
      code: "INVALID_SETTINGS",
    });
  }
  for (const key of old.forbidden) current.forbidden.add(key);
}

function within(root, file) {
  const suffix = relative(root, file);
  return suffix !== ".." && !suffix.startsWith(".." + sep) && !isAbsolute(suffix);
}
function canonical(path) {
  try {
    return realpathSync(path);
  } catch (error) {
    // State directories and rotated credentials need protection before creation, too.
    if (error.code !== "ENOENT" || path === dirname(path)) throw error;
    return join(canonical(dirname(path)), basename(path));
  }
}
function identity(st) {
  return st.dev + ":" + st.ino;
}

function privatePaths(env, extraSecrets) {
  return new Set(
    [
      configDir(),
      credentialsFile(),
      join(configDir(), "service.env"),
      join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "mattermost-mcp"),
      join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "mattermost-mcp"),
      ...[
        env.MM_EVENTS_STATE_DIR,
        env.MM_SETTINGS_FILE,
        env.MM_TOKEN_FILE,
        env.MM_HTTP_TOKEN_FILE,
        env.MM_ADMIN_TOKEN_FILE,
        env.MM_CALLBACK_TARGETS_FILE,
        env.MM_OPENCODE_PASSWORD_FILE,
        ...extraSecrets,
      ].filter(Boolean),
    ].map((p) => resolve(p)),
  );
}

function rootIdentity(st) {
  // Including birth time also distinguishes filesystems that promptly reuse the inode of a removed directory.
  return identity(st) + ":" + st.birthtimeNs;
}
function pinDirectories(roots, paths) {
  return roots.map((path) => {
    const real = realpathSync(path);
    const st = statSync(real, { bigint: true });
    if (!st.isDirectory()) throw new Error("MM_UPLOAD_ROOTS entries must be directories");
    if ([...paths].some((p) => within(real, canonical(p)) || within(canonical(p), real)))
      throw new Error("MM_UPLOAD_ROOTS must not overlap credentials or private state");
    return { path, real, key: rootIdentity(st) };
  });
}

export function protectUploadRoots(roots, env = process.env, extraSecrets = []) {
  const paths = privatePaths(env, extraSecrets);
  const pinned = pinDirectories(roots, paths);
  const forbidden = new Set();
  const rememberProtected = () => {
    for (const path of paths) {
      const st = statSync(path, { bigint: true, throwIfNoEntry: false });
      if (st) forbidden.add(identity(st));
    }
  };
  rememberProtected();
  const access = {
    checkPath(file) {
      const root = pinned.find(
        (p) =>
          within(p.real, file) &&
          realpathSync(p.path) === p.real &&
          rootIdentity(statSync(p.real, { bigint: true })) === p.key,
      );
      if (!root || [...paths].some((p) => within(canonical(p), file)))
        throw new Error("file_path is outside the permitted upload roots or is private");
    },
    checkFile(st) {
      rememberProtected();
      if (st.nlink !== 1n || forbidden.has(identity(st)))
        throw new Error("private files and hard-linked files cannot be uploaded");
    },
  };
  policies.set(access, { forbidden, rootIdentities: JSON.stringify(pinned) });
  return access;
}
