import { expect, it } from "vitest";
import { hasPersonalMention as mention } from "./mentions.js";

it("ignores fenced and inline code, URL destinations and email-like handles", () => {
  for (const input of [
    "see ``text ` @sam.user``",
    "   ~~~~lang\n@sam.user\n~~~\nstill code @sam.user\n~~~~\n",
    "[label](url/@sam.user) and https://example.test/@sam.user",
    "nope@sam.user or @sam.user2 or @sam.user.name",
  ])
    expect(mention(input, "sam.user")).toBe(false);
  expect(mention("[＠SAM.USER](url) and an unmatched `", "sam.user")).toBe(true);
  expect(mention("~~~\n@other\n~~~\n@sam.user!", "sam.user")).toBe(true);
});

it("keeps mentions in long unterminated links and delimiter runs bounded", () => {
  for (const prefix of ["~".repeat(16000), "](".repeat(8000), "`".repeat(16000)]) {
    expect(mention(prefix + " @reader", "reader")).toBe(true);
  }
});
