import { describe, it, expect } from "vitest";
import {
  GuardrailError,
  assertNotReadOnly,
  assertDestructiveAllowed,
  assertWriteAllowed,
  assertTeamAllowed,
  assertChannelAllowed,
  assertMessageWithinLimit,
} from "./guardrails.js";
const g = (over = {}) => ({
  readOnly: false,
  allowDestructive: false,
  teamAllowlist: [],
  channelAllowlist: [],
  maxMessageLen: 16383,
  ...over,
});
const READ = { name: "get_post" };
const WRITE = { name: "post_message", write: true };
const DESTRUCTIVE = { name: "delete_post", destructive: true };
describe("assertNotReadOnly", () => {
  it("blocks a write tool in read-only mode", () => {
    expect(() => assertNotReadOnly(WRITE, g({ readOnly: true }))).toThrow(GuardrailError);
    expect(() => assertNotReadOnly(WRITE, g({ readOnly: true }))).toThrow(/read-only/);
  });
  it("blocks a destructive tool in read-only mode", () => {
    expect(() => assertNotReadOnly(DESTRUCTIVE, g({ readOnly: true }))).toThrow(/read-only/);
  });
  it("allows a read tool in read-only mode", () => {
    expect(() => assertNotReadOnly(READ, g({ readOnly: true }))).not.toThrow();
  });
  it("allows a write tool when not read-only", () => {
    expect(() => assertNotReadOnly(WRITE, g())).not.toThrow();
  });
});
describe("assertDestructiveAllowed", () => {
  it("ignores non-destructive tools", () => {
    expect(() => assertDestructiveAllowed(WRITE, {}, g())).not.toThrow();
  });
  it("blocks when the env flag is off", () => {
    expect(() => assertDestructiveAllowed(DESTRUCTIVE, { confirm: true }, g())).toThrow(
      /MM_ALLOW_DESTRUCTIVE/,
    );
  });
  it("blocks when confirm is missing even with the flag on", () => {
    expect(() => assertDestructiveAllowed(DESTRUCTIVE, {}, g({ allowDestructive: true }))).toThrow(
      /confirm:true/,
    );
  });
  it("blocks when confirm is false", () => {
    expect(() =>
      assertDestructiveAllowed(DESTRUCTIVE, { confirm: false }, g({ allowDestructive: true })),
    ).toThrow(/confirm:true/);
  });
  it("allows with flag on and confirm:true", () => {
    expect(() =>
      assertDestructiveAllowed(DESTRUCTIVE, { confirm: true }, g({ allowDestructive: true })),
    ).not.toThrow();
  });
});
describe("assertWriteAllowed (composition)", () => {
  it("read-only takes precedence over the destructive gate", () => {
    expect(() =>
      assertWriteAllowed(
        DESTRUCTIVE,
        { confirm: true },
        g({ readOnly: true, allowDestructive: true }),
      ),
    ).toThrow(/read-only/);
  });
  it("passes a plain write when not read-only", () => {
    expect(() => assertWriteAllowed(WRITE, {}, g())).not.toThrow();
  });
  it("passes a fully-authorized destructive call", () => {
    expect(() =>
      assertWriteAllowed(DESTRUCTIVE, { confirm: true }, g({ allowDestructive: true })),
    ).not.toThrow();
  });
});
describe("assertTeamAllowed", () => {
  it("allows anything when the list is empty", () => {
    expect(() => assertTeamAllowed("t9", g())).not.toThrow();
  });
  it("allows an in-list team", () => {
    expect(() => assertTeamAllowed("t1", g({ teamAllowlist: ["t1", "t2"] }))).not.toThrow();
  });
  it("blocks an out-of-list team", () => {
    expect(() => assertTeamAllowed("t9", g({ teamAllowlist: ["t1"] }))).toThrow(
      /MM_TEAM_ALLOWLIST/,
    );
  });
});
describe("assertChannelAllowed", () => {
  it("allows anything when the list is empty", () => {
    expect(() => assertChannelAllowed("c9", g())).not.toThrow();
  });
  it("allows an in-list channel", () => {
    expect(() => assertChannelAllowed("c1", g({ channelAllowlist: ["c1"] }))).not.toThrow();
  });
  it("blocks an out-of-list channel", () => {
    expect(() => assertChannelAllowed("c9", g({ channelAllowlist: ["c1"] }))).toThrow(
      /MM_CHANNEL_ALLOWLIST/,
    );
  });
});
describe("assertMessageWithinLimit", () => {
  it("allows a message under the limit", () => {
    expect(() => assertMessageWithinLimit("hello", g({ maxMessageLen: 10 }))).not.toThrow();
  });
  it("allows a message exactly at the limit", () => {
    expect(() => assertMessageWithinLimit("abcde", g({ maxMessageLen: 5 }))).not.toThrow();
  });
  it("blocks a message over the limit", () => {
    expect(() => assertMessageWithinLimit("abcdef", g({ maxMessageLen: 5 }))).toThrow(/exceeds/);
  });
  it("counts code points, not UTF-16 units (emoji)", () => {
    // "😀😀😀" is 3 code points but 6 UTF-16 units.
    expect(() => assertMessageWithinLimit("😀😀😀", g({ maxMessageLen: 3 }))).not.toThrow();
    expect(() => assertMessageWithinLimit("😀😀😀", g({ maxMessageLen: 2 }))).toThrow(/length 3/);
  });
});
