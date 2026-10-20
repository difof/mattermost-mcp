import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useMattermost } from "./mattermost-http-fixture.js";

const CHANNEL = "upload-channel";
const payload = Buffer.concat([
  Buffer.from("Synthetic confidential upload fixture\n"),
  Buffer.from([0, 255, 128]),
]);
const metadata = {
  id: "uploaded-file",
  name: "report with spaces.bin",
  size: payload.length,
  mime_type: "application/octet-stream",
};
const multipartCalls = [
  { name: "upload_file", args: (file_path) => ({ channel_id: CHANNEL, file_path }) },
  {
    name: "api_call",
    args: (file_path) => ({
      operation: "POST /api/v4/files",
      body: { channel_id: CHANNEL },
      files: [{ field: "files", file_path }],
    }),
  },
];

describe("confidential local uploads through MCP and HTTP", () => {
  const uploads = { roots: [], maxBytes: payload.length };
  const fixture = useMattermost({ uploads });
  let directory;
  let path;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "mattermost-local-upload-"));
    uploads.roots = [directory];
    uploads.maxBytes = payload.length;
    path = join(directory, metadata.name);
    await writeFile(path, payload);
  });
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it.each(multipartCalls)(
    "$name sends local bytes while the MCP exchange contains only path and metadata",
    async ({ name, args }) => {
      const mm = fixture();
      mm.expect("POST", "/files", {
        fetchRedirect: "manual",
        inspectBody: async (body, headers) => {
          const form = await new Response(body, {
            headers: { "Content-Type": headers["content-type"] },
          }).formData();
          expect([...form.keys()]).toEqual(["channel_id", "files"]);
          expect(form.get("channel_id")).toBe(CHANNEL);
          const file = form.get("files");
          expect(file.name).toBe(metadata.name);
          expect(file.type).toBe(metadata.mime_type);
          expect(Buffer.from(await file.arrayBuffer())).toEqual(payload);
        },
        reply: { file_infos: [metadata], client_ids: [] },
      });
      const input = args(path);
      const result = await mm.result(name, input);
      expect(result.isError).not.toBe(true);
      const value = JSON.parse(result.text);
      expect(name === "upload_file" ? value : value.data.file_infos).toEqual([metadata]);
      const transcript = JSON.stringify({ input, result });
      expect(transcript).not.toContain(payload.toString("base64"));
      expect(transcript).not.toContain("Synthetic confidential upload fixture");
      expect(result.text).not.toContain(path);
      // The fixture expects no POST /posts: uploading does not send a message.
    },
  );

  it.each([false, true])(
    "sends a raw local body without inline encoding (empty=%s)",
    async (empty) => {
      const mm = fixture();
      const bytes = empty ? Buffer.alloc(0) : payload;
      if (empty) await writeFile(path, bytes);
      mm.expect("POST", "/uploads/upload-session", {
        requestHeaders: { "content-type": "application/octet-stream" },
        fetchRedirect: "manual",
        inspectBody: (body) => expect(body).toEqual(bytes),
        reply: { ...metadata, size: bytes.length },
      });
      const result = await mm.call("api_call", {
        operation: "POST /api/v4/uploads/{upload_id}",
        path: { upload_id: "upload-session" },
        body_file_path: path,
      });
      expect(result).toMatchObject({ status: 200, data: { id: metadata.id, size: bytes.length } });
      expect(result).not.toHaveProperty("body_base64");
    },
  );

  it("enforces upload policy before trying a local file", async () => {
    const mm = fixture();
    const missing = join(directory, "does-not-exist.bin");
    mm.guardrails.readOnly = true;
    for (const { name, args } of multipartCalls) {
      expect(await mm.error(name, args(missing))).toMatch(/read-only/);
    }
    mm.guardrails.readOnly = false;
    mm.guardrails.channelAllowlist = ["another-channel"];
    expect(await mm.error("upload_file", { channel_id: CHANNEL, file_path: missing })).toContain(
      "MM_CHANNEL_ALLOWLIST",
    );
    expect(await mm.error("api_call", multipartCalls[1].args(missing))).toContain(
      "api_call is unavailable",
    );
  });

  it("refuses local files when no roots are configured", async () => {
    const mm = fixture();
    uploads.roots = [];
    for (const { name, args } of multipartCalls) {
      expect(await mm.error(name, args(path))).toContain("MM_UPLOAD_ROOTS");
    }
    // Existing inline multipart contracts separately verify successful binary transfer.
    expect(
      await mm.error("api_call", { operation: "POST /api/v4/files", body_file_path: path }),
    ).toContain("MM_UPLOAD_ROOTS");
  });

  it("rejects conflicting sources, unsupported media and malformed headers before local reads", async () => {
    const mm = fixture();
    const missing = join(directory, "does-not-exist.bin");
    expect(
      await mm.error("upload_file", {
        channel_id: CHANNEL,
        filename: "x",
        file_path: missing,
        content_base64: "",
      }),
    ).toContain("exactly one");
    expect(await mm.error("upload_file", { channel_id: CHANNEL, content_base64: "" })).toContain(
      "filename",
    );
    for (const other of [
      { body_base64: "" },
      { body: {} },
      { files: [{ field: "files", file_path: missing }] },
    ]) {
      expect(
        await mm.error("api_call", {
          operation: "POST /api/v4/files",
          body_file_path: missing,
          ...other,
        }),
      ).toContain("mutually exclusive");
    }
    expect(
      await mm.error("api_call", {
        operation: "POST /api/v4/files",
        body: { channel_id: CHANNEL },
        files: [{ field: "files", file_path: missing, content_base64: "", filename: "x" }],
      }),
    ).toContain("exactly one");
    expect(
      await mm.error("api_call", { operation: "POST /api/v4/users/ids", body_file_path: missing }),
    ).toContain("not supported");
    expect(
      await mm.error("api_call", { operation: "POST /api/v4/posts", body_file_path: missing }),
    ).toContain("JSON body");
    expect(
      await mm.error("api_call", {
        operation: "POST /api/v4/files",
        body_file_path: missing,
        content_type: "application/octet-stream\r\nX-Bad: value",
      }),
    ).toMatch(/header/i);
  });

  it("shares the byte cap across local and inline multipart parts before HTTP", async () => {
    const mm = fixture();
    const error = await mm.error("api_call", {
      operation: "POST /api/v4/files",
      body: { channel_id: CHANNEL },
      files: [
        { field: "files", file_path: path },
        { field: "files", filename: "extra.bin", content_base64: "AA==" },
      ],
    });
    expect(error).toContain("MM_MAX_UPLOAD_BYTES");
    expect(error).not.toContain(payload.toString("base64"));
    expect(error).not.toContain("Synthetic confidential upload fixture");
  });

  it("does not expose malformed upload response snippets in MCP errors", async () => {
    const mm = fixture();
    mm.expect("POST", "/files", {
      inspectBody: () => {},
      bytes: payload,
      headers: { "Content-Type": "application/json" },
    });
    expect(await mm.error("upload_file", { channel_id: CHANNEL, file_path: path })).toBe(
      "invalid upload metadata JSON (HTTP 200)",
    );
  });

  it.each(multipartCalls)(
    "$name never follows an upload redirect or retries an ambiguous failure",
    async ({ name, args }) => {
      const mm = fixture();
      mm.expect("POST", "/files", {
        fetchRedirect: "manual",
        inspectBody: () => {},
        status: 307,
        empty: true,
        headers: { Location: "https://outside.invalid/capture" },
      });
      const redirected = await mm.result(name, args(path));
      if (name === "upload_file") {
        expect(redirected.isError).toBe(true);
        expect(redirected.text).toContain("307");
      } else {
        expect(redirected.isError).not.toBe(true);
        expect(JSON.parse(redirected.text)).toMatchObject({ status: 307 });
      }
      mm.expect("POST", "/files", {
        fetchRedirect: "manual",
        inspectBody: () => {},
        status: 503,
        reply: { status_code: 503, message: "Upload outcome unknown" },
      });
      expect(await mm.error(name, args(path))).toContain("503");
      // Any follow or automatic retry has no expectation and fails the fixture.
    },
  );
});
