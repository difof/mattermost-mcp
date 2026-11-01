import { constants, openSync, closeSync, fstatSync, readFileSync } from "node:fs";

/** Read one private secret; allow a trailing line ending but preserve significant spaces. */
export function readSecretFile(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (
      !st.isFile() ||
      st.size > 4096 ||
      (process.platform !== "win32" && (st.mode & 0o077) !== 0)
    ) {
      throw new Error("Expected a private regular secret file (mode 0600 or 0400; at most 4 KiB)");
    }
    return readFileSync(fd, "utf8").replace(/\r?\n$/, "");
  } finally {
    closeSync(fd);
  }
}
