import { z } from "zod";
import { routeSegment } from "./route-params.js";
import { fetchFileContent, uploadFileContent } from "../mattermost/files.js";
import { createUploadReader } from "../mattermost/uploads.js";
import { uploadFields, refineUpload } from "./upload-params.js";
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
// ---------------------------------------------------------------------------
// upload_file — POST /files (multipart)
// ---------------------------------------------------------------------------
const uploadFile = {
  name: "upload_file",
  title: "Upload file",
  description:
    "Upload a file to a channel from file_path on the MCP server (requires MM_UPLOAD_ROOTS) or inline content_base64. Local bytes stay out of tool arguments/results. Returns file metadata/ids to attach with post_message.file_ids; does not post a message.",
  inputSchema: z
    .object({
      channel_id: routeSegment.describe("Channel to upload the file into."),
      ...uploadFields,
    })
    .strict()
    .superRefine(refineUpload),
  write: true,
  resources: (args) => ({ channelId: args.channel_id }),
  handler: (args, { session }) =>
    session.call(async (c) => {
      const { bytes, filename } = await createUploadReader(session.config.uploads)(args);
      const fd = new FormData();
      fd.append("channel_id", args.channel_id);
      fd.append(
        "files",
        new Blob([bytes], { type: args.content_type ?? "application/octet-stream" }),
        filename,
      );
      const resp = await uploadFileContent(c, fd);
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
  inputSchema: z
    .object({
      file_id: routeSegment.describe("File id."),
    })
    .strict(),
  resources: (args) => ({ fileId: args.file_id }),
  handler: (args, { resources }) => resources.file(args.file_id),
};
// ---------------------------------------------------------------------------
// get_file — GET /files/{id}
// ---------------------------------------------------------------------------
const getFile = {
  name: "get_file",
  title: "Get file",
  description:
    "Download a file and return its content as base64 (GET /files/{id}). Capped at max_bytes to prevent huge payloads.",
  inputSchema: z
    .object({
      file_id: routeSegment.describe("File id."),
      max_bytes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`Maximum number of bytes to accept (default ${DEFAULT_MAX_BYTES}).`),
    })
    .strict(),
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
