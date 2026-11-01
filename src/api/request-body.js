import { Blob } from "node:buffer";
import { createUploadReader } from "../mattermost/uploads.js";

function bodyInputs(args) {
  const hasBody = Object.hasOwn(args, "body");
  const hasBase64 = args.body_base64 !== undefined;
  const hasFile = args.body_file_path !== undefined;
  const hasBytes = hasBase64 || hasFile;
  if (hasBase64 && hasFile)
    throw new Error("body_base64 and body_file_path are mutually exclusive");
  if (hasBytes && (hasBody || args.files))
    throw new Error("body_base64/body_file_path are mutually exclusive with body and files");
  if (!hasBody && !hasBytes && !args.files) {
    if (args.content_type) throw new Error("content_type requires a request body");
    return null;
  }
  return { hasBody, hasBytes };
}

function contentTypeFor(operation, args, { hasBytes }) {
  const mediaTypes = Object.keys(operation.requestBody?.content ?? {});
  // Missing body schemas are a known upstream omission; JSON remains usable.
  const allowed = mediaTypes.length ? mediaTypes : ["application/json"];
  const preferred = args.files
    ? "multipart/form-data"
    : hasBytes
      ? "application/octet-stream"
      : allowed.includes("application/json")
        ? "application/json"
        : allowed[0];
  const contentType = new Headers({ "Content-Type": args.content_type ?? preferred }).get(
    "content-type",
  );
  const media = contentType.split(";")[0].trim().toLowerCase();
  if (!allowed.map((type) => type.toLowerCase()).includes(media)) {
    throw new Error(
      `content_type '${media}' is not supported for this operation; use api_describe`,
    );
  }
  return { contentType, media };
}

async function multipartBody(args, uploads, { hasBody, hasBytes }) {
  if (hasBytes) throw new Error("multipart uploads use files, not body_base64/body_file_path");
  if (
    hasBody &&
    (args.body === null || typeof args.body !== "object" || Array.isArray(args.body))
  ) {
    throw new Error("multipart body must be an object of form fields");
  }
  const form = new FormData();
  const readUpload = createUploadReader(uploads);
  for (const [field, value] of Object.entries(args.body ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) {
      form.append(
        field,
        item !== null && typeof item === "object" ? JSON.stringify(item) : String(item),
      );
    }
  }
  for (const file of args.files ?? []) {
    const { bytes, filename } = await readUpload(file);
    form.append(
      file.field,
      new Blob([bytes], {
        type: file.content_type ?? "application/octet-stream",
      }),
      filename,
    );
  }
  // fetch must generate the boundary; a caller-provided boundary is never used.
  return form;
}

export async function requestBody(operation, args, headers, uploads) {
  const inputs = bodyInputs(args);
  if (!inputs) return undefined;
  if (["GET", "HEAD"].includes(operation.method))
    throw new Error(`${operation.method} operations do not accept a request body`);
  const { contentType, media } = contentTypeFor(operation, args, inputs);
  if (media === "multipart/form-data") return multipartBody(args, uploads, inputs);
  if (args.files) throw new Error("files requires multipart/form-data");
  // Match Client4's spelling so its JSON default is replaced, not duplicated.
  headers["Content-Type"] = contentType;
  if (media === "application/json" || media.endsWith("+json")) {
    if (inputs.hasBytes) throw new Error("JSON requests use body, not body_base64/body_file_path");
    return JSON.stringify(args.body);
  }
  if (!inputs.hasBytes) throw new Error("binary requests require body_base64 or body_file_path");
  const { bytes } = await createUploadReader(uploads)({
    content_base64: args.body_base64,
    file_path: args.body_file_path,
  });
  return bytes;
}
