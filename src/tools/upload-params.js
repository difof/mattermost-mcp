import { z } from "zod";

// Shared multipart source fields; raw API bodies do not require a filename.
export const uploadFields = {
  filename: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Required with content_base64; defaults to the local file's basename with file_path.",
    ),
  content_base64: z.string().optional().describe("Inline bytes, exclusive with file_path."),
  file_path: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Absolute file path on the MCP server; requires MM_UPLOAD_ROOTS. No bytes enter the tool arguments.",
    ),
  content_type: z
    .string()
    .optional()
    .describe("File media type; default application/octet-stream."),
};

export function refineUpload(args, ctx) {
  if ((args.file_path !== undefined) === (args.content_base64 !== undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "provide exactly one of file_path or content_base64",
    });
  }
  if (args.content_base64 !== undefined && args.filename === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["filename"],
      message: "filename is required with content_base64",
    });
  }
}
