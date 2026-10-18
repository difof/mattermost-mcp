import { z } from "zod";
import { fetchFileContent, fetchFileMetadata } from "../mattermost/files.js";
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
// ---------------------------------------------------------------------------
// upload_file — POST /files (multipart)
// ---------------------------------------------------------------------------
const uploadFile = {
  name: "upload_file",
  title: "Upload file",
  description:
    "Upload a file to a channel (POST /files multipart). Returns file ids that can be passed to post_message.file_ids.",
  inputSchema: z.object({
    channel_id: z.string().describe("Channel to upload the file into."),
    filename: z.string().describe("File name (including extension)."),
    content_base64: z.string().describe("File bytes encoded as base64."),
  }),
  write: true,
  resources: (args) => ({ channelId: args.channel_id }),
  handler: (args, { session }) =>
    session.call(async (c) => {
      const bytes = Buffer.from(args.content_base64, "base64");
      const fd = new FormData();
      fd.append("channel_id", args.channel_id);
      fd.append("files", new Blob([bytes]), args.filename);
      const resp = await c.uploadFile(fd);
      return resp.file_infos.map((f) => ({
        id: f.id,
        name: f.name,
        size: f.size,
        mime_type: f.mime_type,
      }));
    }),
};
// ---------------------------------------------------------------------------
// get_file_metadata — GET /files/{id}/info
// ---------------------------------------------------------------------------
const getFileMetadata = {
  name: "get_file_metadata",
  title: "Get file metadata",
  description: "Fetch metadata for a file (GET /files/{id}/info).",
  inputSchema: z.object({
    file_id: z.string().describe("File id."),
  }),
  resources: (args) => ({ fileId: args.file_id }),
  handler: (args, { session }) => session.call((c) => fetchFileMetadata(c, args.file_id)),
};
// ---------------------------------------------------------------------------
// get_file — GET /files/{id}
// ---------------------------------------------------------------------------
const getFile = {
  name: "get_file",
  title: "Get file",
  description:
    "Download a file and return its content as base64 (GET /files/{id}). Capped at max_bytes to prevent huge payloads.",
  inputSchema: z.object({
    file_id: z.string().describe("File id."),
    max_bytes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(`Maximum number of bytes to accept (default ${DEFAULT_MAX_BYTES}).`),
  }),
  resources: (args) => ({ fileId: args.file_id }),
  handler: (args, { session }) =>
    session.call(async (c) => {
      const buf = await fetchFileContent(c, args.file_id, args.max_bytes ?? DEFAULT_MAX_BYTES);
      return {
        file_id: args.file_id,
        bytes: buf.byteLength,
        content_base64: buf.toString("base64"),
      };
    }),
};
export const fileTools = [uploadFile, getFile, getFileMetadata];
