import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { DEFAULT_MAX_UPLOAD_BYTES } from "../config.js";
import { protectUploadRoots } from "./upload-access.js";
import { decodeBase64 } from "./binary.js";

async function inspectOpenedFile(file, path, maxBytes) {
  const before = await file.stat({ bigint: true });
  if (!before.isFile()) throw new Error("file_path must identify a regular file");
  // Match the allowlisted pathname to the opened descriptor before reading any bytes.
  const current = await stat(path, { bigint: true });
  if ((await realpath(path)) !== path || current.dev !== before.dev || current.ino !== before.ino) {
    throw new Error("upload file changed while opening; retry with a stable file");
  }
  if (before.size > BigInt(maxBytes)) throw new Error("upload exceeds MM_MAX_UPLOAD_BYTES");
  return before;
}

async function readSnapshot(file, before) {
  const bytes = Buffer.alloc(Number(before.size));
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  // Probe one byte beyond the original size, never read an unbounded growing file.
  const { bytesRead: extra } = await file.read(Buffer.alloc(1), 0, 1, bytes.length);
  const after = await file.stat({ bigint: true });
  if (
    offset !== bytes.length ||
    extra ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  ) {
    throw new Error("upload file changed while reading; retry with a stable file");
  }
  return bytes;
}

async function readLocalFile(path, roots, maxBytes, access) {
  if (!roots.length) throw new Error("local uploads are disabled; configure MM_UPLOAD_ROOTS");
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new Error("file_path must be an absolute local path without shell expansion");
  }
  try {
    const policy = access ?? protectUploadRoots(roots);
    const resolved = await realpath(path);
    policy.checkPath(resolved);
    // Nonblocking open avoids a FIFO race; no-follow rejects a swapped final symlink.
    const file = await open(
      resolved,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const before = await inspectOpenedFile(file, resolved, maxBytes);
      policy.checkFile(before);
      const bytes = await readSnapshot(file, before);
      policy.checkPath(resolved);
      policy.checkFile(await file.stat({ bigint: true }));
      return bytes;
    } finally {
      await file.close();
    }
  } catch (error) {
    // Filesystem errors can include full paths; surface only the reason.
    if (error.code) throw new Error(`cannot read upload file (${error.code})`);
    throw error;
  }
}

/** Capture upload bytes once, with one shared byte budget per tool call. */
export function createUploadReader(config = {}) {
  const { roots = [], maxBytes = DEFAULT_MAX_UPLOAD_BYTES } = config;
  let remaining = maxBytes;
  return async ({ file_path, content_base64, filename }) => {
    if ((file_path !== undefined) === (content_base64 !== undefined)) {
      throw new Error("provide exactly one of file_path or content_base64");
    }
    let bytes;
    if (file_path !== undefined) {
      bytes = await readLocalFile(file_path, roots, remaining, config.access);
    } else {
      if (content_base64.length > 4 * Math.ceil(remaining / 3)) {
        throw new Error("upload exceeds MM_MAX_UPLOAD_BYTES");
      }
      bytes = decodeBase64(content_base64);
    }
    if (bytes.length > remaining) throw new Error("upload exceeds MM_MAX_UPLOAD_BYTES");
    remaining -= bytes.length;
    return {
      bytes,
      filename: filename ?? (file_path === undefined ? undefined : basename(file_path)),
    };
  };
}
