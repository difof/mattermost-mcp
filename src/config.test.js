import { describe, it, expect } from "vitest";
import { loadConfig } from "./config.js";
const base = { MM_URL: "https://mm.example.com" };
describe("loadConfig — url", () => {
  it("rejects a missing url", () => {
    expect(() => loadConfig({ MM_TOKEN: "x" })).toThrow(/MM_URL/);
  });
  it("rejects an invalid url", () => {
    expect(() => loadConfig({ MM_URL: "not-a-url", MM_TOKEN: "x" })).toThrow(/MM_URL/);
  });
  it("strips trailing slashes", () => {
    const c = loadConfig({ MM_URL: "https://mm.example.com//", MM_TOKEN: "x" });
    expect(c.url).toBe("https://mm.example.com");
  });
  it("preserves a valid deployment subpath", () => {
    const c = loadConfig({ MM_URL: "https://mm.example.com/mattermost/", MM_TOKEN: "x" });
    expect(c.url).toBe("https://mm.example.com/mattermost");
  });
  it.each([
    "file:///tmp/mattermost",
    "ftp://mm.example.com",
    "https://username:password@mm.example.com",
    "https://mm.example.com?redirect=elsewhere",
    "https://mm.example.com#fragment",
    "https://mm.example.com/api/v4/",
  ])("rejects an unusable or ambiguous server root: %s", (MM_URL) => {
    expect(() => loadConfig({ MM_URL, MM_TOKEN: "x" })).toThrow(/MM_URL/);
  });
  it("allows HTTP for local self-hosted servers", () => {
    const c = loadConfig({ MM_URL: "http://127.0.0.1:8065", MM_TOKEN: "x" });
    expect(c.url).toBe("http://127.0.0.1:8065");
  });
});
describe("loadConfig — auth", () => {
  it("defaults to pat mode and requires MM_TOKEN", () => {
    expect(() => loadConfig({ ...base })).toThrow(/MM_TOKEN/);
  });
  it("parses pat config", () => {
    const c = loadConfig({ ...base, MM_TOKEN: "abc" });
    expect(c.auth).toEqual({ mode: "pat", token: "abc" });
  });
  it("requires login id and password in password mode", () => {
    expect(() => loadConfig({ ...base, MM_AUTH_MODE: "password" })).toThrow(
      /MM_LOGIN_ID[\s\S]*MM_PASSWORD/,
    );
  });
  it("parses password config without mfa", () => {
    const c = loadConfig({ ...base, MM_AUTH_MODE: "password", MM_LOGIN_ID: "u", MM_PASSWORD: "p" });
    expect(c.auth).toEqual({ mode: "password", loginId: "u", password: "p" });
  });
  it("parses password config with mfa", () => {
    const c = loadConfig({
      ...base,
      MM_AUTH_MODE: "password",
      MM_LOGIN_ID: "u",
      MM_PASSWORD: "p",
      MM_MFA_TOKEN: "123456",
    });
    expect(c.auth).toEqual({ mode: "password", loginId: "u", password: "p", mfaToken: "123456" });
  });
  it("requires client id and secret in oauth2 mode", () => {
    expect(() => loadConfig({ ...base, MM_AUTH_MODE: "oauth2" })).toThrow(/MM_CLIENT_ID/);
  });
  it("parses oauth2 config with redirect default", () => {
    const c = loadConfig({
      ...base,
      MM_AUTH_MODE: "oauth2",
      MM_CLIENT_ID: "cid",
      MM_CLIENT_SECRET: "secret",
    });
    expect(c.auth).toEqual({
      mode: "oauth2",
      clientId: "cid",
      clientSecret: "secret",
      redirect: "http://127.0.0.1:7000/callback",
    });
  });
  it("rejects an unknown auth mode", () => {
    expect(() => loadConfig({ ...base, MM_AUTH_MODE: "saml", MM_TOKEN: "x" })).toThrow(
      /MM_AUTH_MODE/,
    );
  });
});
describe("loadConfig — guardrails", () => {
  it("applies safe defaults", () => {
    const c = loadConfig({ ...base, MM_TOKEN: "x" });
    expect(c.guardrails).toEqual({
      readOnly: false,
      allowDestructive: false,
      teamAllowlist: [],
      channelAllowlist: [],
      maxMessageLen: 16383,
    });
  });
  it("parses overrides and trims CSV allowlists", () => {
    const c = loadConfig({
      ...base,
      MM_TOKEN: "x",
      MM_READ_ONLY: "true",
      MM_ALLOW_DESTRUCTIVE: "true",
      MM_TEAM_ALLOWLIST: "t1, t2 ,t3",
      MM_CHANNEL_ALLOWLIST: "c1",
      MM_MAX_MESSAGE_LEN: "100",
    });
    expect(c.guardrails).toEqual({
      readOnly: true,
      allowDestructive: true,
      teamAllowlist: ["t1", "t2", "t3"],
      channelAllowlist: ["c1"],
      maxMessageLen: 100,
    });
  });
  it("rejects a non-boolean flag", () => {
    expect(() => loadConfig({ ...base, MM_TOKEN: "x", MM_READ_ONLY: "yes" })).toThrow(
      /MM_READ_ONLY/,
    );
  });
  it("rejects a non-positive message length", () => {
    expect(() => loadConfig({ ...base, MM_TOKEN: "x", MM_MAX_MESSAGE_LEN: "0" })).toThrow(
      /MM_MAX_MESSAGE_LEN/,
    );
  });
});
