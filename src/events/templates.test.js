import { expect, it } from "vitest";
import { notificationTemplate } from "./templates.js";
it("renders message text once as data and rejects unsupported template logic or missing variables", () => {
  const text = "{{senderId}}: {{message}}";
  const template = notificationTemplate(text);
  expect(template.render({ senderId: "sender", message: "{{accountId}} <&>" })).toBe(
    "sender: {{accountId}} <&>",
  );
  expect(() => template.render({ senderId: "sender" })).toThrow(/Missing/);
  for (const source of ["{{#message}}x{{/message}}", "{{>file}}", "{{unknown}}"])
    expect(() => notificationTemplate(source)).toThrow();
  expect(template.revision).toBe(notificationTemplate(text).revision);
});
