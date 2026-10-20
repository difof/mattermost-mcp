import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUploadReader } from "./uploads.js";

describe("upload sources", () => {
  let directory;
  let root;
  let outside;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "mm-upload-"));
    root = join(directory, "approved");
    outside = join(directory, "approved-sibling");
    await Promise.all([mkdir(root), mkdir(outside)]);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const file = async (path, bytes) => {
    await writeFile(path, bytes);
    return path;
  };

  it("accepts inline binary and empty content without requiring a filename", async () => {
    const read = createUploadReader();
    const bytes = Buffer.from([0, 255, 13, 10, 128]);
    expect(await read({ content_base64: bytes.toString("base64") })).toMatchObject({ bytes });
    expect(await read({ content_base64: "", filename: "empty.bin" })).toEqual({
      bytes: Buffer.alloc(0),
      filename: "empty.bin",
    });
  });

  it("requires exactly one source, including an explicitly empty base64 value", async () => {
    const read = createUploadReader({ roots: [root], maxBytes: 10 });
    await expect(read({})).rejects.toThrow(/exactly one|one source/i);
    await expect(read({ file_path: join(root, "sample.bin"), content_base64: "" })).rejects.toThrow(
      /exactly one|one source/i,
    );
    await expect(read({ content_base64: "aGk" })).rejects.toThrow(/canonical base64/i);
  });

  it("reads binary paths with spaces and supports default or explicit filenames", async () => {
    const bytes = Buffer.from([0, 255, 65, 13, 10, 128]);
    const file_path = await file(join(root, "private notes.bin"), bytes);
    const read = createUploadReader({ roots: [root], maxBytes: bytes.length * 2 });
    expect(await read({ file_path })).toEqual({ bytes, filename: "private notes.bin" });
    expect(await read({ file_path, filename: "attachment.bin" })).toEqual({
      bytes,
      filename: "attachment.bin",
    });
  });

  it("accepts an empty local file after consuming the exact byte budget", async () => {
    const file_path = await file(join(root, "empty.bin"), Buffer.alloc(0));
    const read = createUploadReader({ roots: [root], maxBytes: 1 });
    await read({ content_base64: "YQ==" });
    expect(await read({ file_path })).toEqual({ bytes: Buffer.alloc(0), filename: "empty.bin" });
  });

  it("shares one aggregate byte limit across inline and local sources", async () => {
    const file_path = await file(join(root, "sample.bin"), Buffer.from([0, 255, 128]));
    const read = createUploadReader({ roots: [root], maxBytes: 5 });
    await read({ content_base64: "YWI=" });
    expect((await read({ file_path })).bytes).toEqual(Buffer.from([0, 255, 128]));
    await expect(read({ content_base64: "Yw==" })).rejects.toThrow(/max.*bytes|byte.*limit/i);
  });

  it("refuses an oversized sparse local file", async () => {
    const file_path = await file(join(root, "oversized.bin"), Buffer.alloc(0));
    await truncate(file_path, 1024 * 1024);
    const read = createUploadReader({ roots: [root], maxBytes: 8 });
    await expect(read({ file_path })).rejects.toThrow(/max.*bytes|byte.*limit/i);
  });

  it("keeps local uploads disabled without approved roots", async () => {
    const file_path = await file(join(root, "sample.bin"), "synthetic-private-content");
    await expect(createUploadReader()({ file_path })).rejects.toThrow(/disabled|roots/i);
    await expect(createUploadReader({ roots: [], maxBytes: 100 })({ file_path })).rejects.toThrow(
      /disabled|roots/i,
    );
  });

  it("requires an absolute literal local path", async () => {
    const read = createUploadReader({ roots: [root], maxBytes: 10 });
    await expect(read({ file_path: "sample.bin" })).rejects.toThrow(/absolute/i);
    await expect(read({ file_path: "~/sample.bin" })).rejects.toThrow(/absolute/i);
  });

  it("rejects a sibling whose directory name shares the approved root prefix", async () => {
    const file_path = await file(join(outside, "private.bin"), "synthetic-private-content");
    const read = createUploadReader({ roots: [root], maxBytes: 100 });
    await expect(read({ file_path })).rejects.toThrow(/outside|approved|allowed|roots/i);
  });

  it("allows an in-root symlink and rejects an escaping symlink", async () => {
    const bytes = Buffer.from([0, 255, 128]);
    const inside = await file(join(root, "target.bin"), bytes);
    const external = await file(join(outside, "target.bin"), "synthetic-private-content");
    const safeLink = join(root, "safe.bin");
    const escapeLink = join(root, "escape.bin");
    await symlink(inside, safeLink, "file");
    await symlink(external, escapeLink, "file");
    const read = createUploadReader({ roots: [root], maxBytes: 100 });
    expect((await read({ file_path: safeLink })).bytes).toEqual(bytes);
    await expect(read({ file_path: escapeLink })).rejects.toThrow(
      /outside|approved|allowed|roots/i,
    );
  });

  it("resolves directory symlinks in approved roots", async () => {
    const alias = join(directory, "approved-alias");
    await symlink(root, alias, "junction");
    const bytes = Buffer.from("synthetic");
    await file(join(root, "sample.bin"), bytes);
    const read = createUploadReader({ roots: [alias], maxBytes: bytes.length });
    expect((await read({ file_path: join(alias, "sample.bin") })).bytes).toEqual(bytes);
  });

  it("requires regular files and directory roots", async () => {
    const file_path = await file(join(root, "sample.bin"), "synthetic");
    await expect(
      createUploadReader({ roots: [root], maxBytes: 100 })({ file_path: root }),
    ).rejects.toThrow(/regular file|directory/i);
    await expect(
      createUploadReader({ roots: [file_path], maxBytes: 100 })({ file_path }),
    ).rejects.toThrow(/directory|directories/i);
  });

  it("reports missing-file failures without echoing private paths", async () => {
    const file_path = join(root, "private-unpublished-name.bin");
    const read = createUploadReader({ roots: [root], maxBytes: 100 });
    const error = await read({ file_path }).catch((error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("ENOENT");
    expect(error.message).not.toContain(file_path);
    expect(error.message).not.toContain(root);
  });
});
