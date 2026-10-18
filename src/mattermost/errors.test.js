import { describe, it, expect } from "vitest";
import mattermost from "@mattermost/client";
import { formatMattermostError } from "./errors.js";
function clientError(data) {
  return new mattermost.ClientError("https://mm.example.com", data);
}
describe("formatMattermostError", () => {
  it("renders status + message verbatim", () => {
    expect(formatMattermostError(clientError({ message: "Forbidden", status_code: 403 }))).toBe(
      "Mattermost API error 403: Forbidden",
    );
  });
  it("appends the server_error_id when present", () => {
    const out = formatMattermostError(
      clientError({
        message: "Not found",
        status_code: 404,
        server_error_id: "api.post.get.app_error",
      }),
    );
    expect(out).toBe("Mattermost API error 404: Not found [api.post.get.app_error]");
  });
  it("appends a distinct detailed_error", () => {
    const out = formatMattermostError(
      clientError({
        message: "Bad request",
        status_code: 400,
        detailed_error: "channel_id is required",
      }),
    );
    expect(out).toBe("Mattermost API error 400: Bad request (channel_id is required)");
  });
  it("falls back to 0 when status is absent", () => {
    expect(formatMattermostError(clientError({ message: "boom" }))).toBe(
      "Mattermost API error 0: boom",
    );
  });
  it("passes through a plain Error message", () => {
    expect(formatMattermostError(new Error("network down"))).toBe("network down");
  });
  it("stringifies a non-Error value", () => {
    expect(formatMattermostError("nope")).toBe("nope");
  });
});
