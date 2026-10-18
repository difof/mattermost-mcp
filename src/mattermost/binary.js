import { Buffer } from "node:buffer";

export function decodeBase64(value) {
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw new Error("binary content must be canonical base64");
  }
  return bytes;
}
