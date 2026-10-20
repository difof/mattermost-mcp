import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, sep } from "node:path";
import { DEFAULT_MAX_UPLOAD_BYTES } from "../config.js";
import { decodeBase64 } from "./binary.js";

function within(root, path) {
  const suffix = relative(root, path);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

async function readLocalFile(path, roots, maxBytes) {
  if (!roots.length) throw new Error("local uploads are disabled; configure MM_UPLOAD_ROOTS");
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new Error("file_path must be an absolute local path without shell expansion");
  }
  let file;
  try {
    const directories = await Promise.all(
      roots.map(async (root) => {
        const directory = await realpath(root);
        if (!(await stat(directory)).isDirectory()) {
          throw new Error("MM_UPLOAD_ROOTS entries must be directories");
        }
        return directory;
      }),
    );
    const resolved = await realpath(path);
    if (!directories.some((directory) => within(directory, resolved))) {
      throw new Error("file_path is outside MM_UPLOAD_ROOTS (including resolved symlinks)");
    }
    // Nonblocking open avoids a FIFO race; no-follow rejects a swapped final symlink.
    file = await open(
      resolved,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const before = await file.stat({ bigint: true });
    if (!before.isFile()) throw new Error("file_path must identify a regular file");
    // Recheck the pathname against the opened descriptor before reading any bytes.
    const current = await stat(resolved, { bigint: true });
    if (
      (await realpath(resolved)) !== resolved ||
      current.dev !== before.dev ||
      current.ino !== before.ino
    ) {
      throw new Error("upload file changed while opening; retry with a stable file");
    }
    if (before.size > BigInt(maxBytes)) throw new Error("upload exceeds MM_MAX_UPLOAD_BYTES");
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    // Never read an unbounded growing file. Probe one byte beyond the original size.
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
  } catch (error) {
    // Filesystem errors can include full paths; surface the reason, never a data buffer.
    if (error.code) throw new Error(`cannot read upload file (${error.code})`);
    throw error;
  } finally {
    await file?.close();
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
      bytes = await readLocalFile(file_path, roots, remaining);
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
