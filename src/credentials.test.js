import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
  chmodSync,
  readFileSync,
  symlinkSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  StoredCredentialsSchema,
  readCredentials,
  writeCredentials,
  clearCredentials,
  resolveConfig,
} from "./credentials.js";
const dir = mkdtempSync(join(tmpdir(), "mm-cred-"));
const file = join(dir, "credentials.json");
beforeEach(() => vi.stubEnv("XDG_CONFIG_HOME", dir));
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(join(dir, "mattermost-mcp"), { recursive: true, force: true });
  try {
    rmSync(file);
  } catch {
    // already gone
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const PAT = {
  url: "https://mm.example.com",
  auth: { mode: "pat", token: "tok-123" },
};
const OAUTH = {
  url: "https://mm.example.com",
  auth: {
    mode: "oauth2",
    clientId: "cid",
    clientSecret: "secret",
    redirect: "http://127.0.0.1:7000/callback",
  },
};
describe("StoredCredentialsSchema", () => {
  it("rejects a password mode (never persisted)", () => {
    const bad = { url: "https://mm.example.com", auth: { mode: "password", loginId: "a" } };
    expect(StoredCredentialsSchema.safeParse(bad).success).toBe(false);
  });
  it("rejects a non-URL server", () => {
    expect(StoredCredentialsSchema.safeParse({ ...PAT, url: "not-a-url" }).success).toBe(false);
  });
});
describe("write / read / clear", () => {
  it.each([PAT, OAUTH])(
    "round-trips $auth.mode credentials through a private file",
    (credentials) => {
      writeCredentials(credentials, file);
      expect(readCredentials(file)).toEqual(credentials);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    },
  );
  it("repairs permissions when replacing an existing credential file", () => {
    writeFileSync(file, "old credentials");
    chmodSync(file, 0o644);
    writeCredentials(PAT, file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readCredentials(file)).toEqual(PAT);
  });
  it("replaces a destination symlink without writing secrets into its target", () => {
    const target = join(dir, "symlink-target.txt");
    writeFileSync(target, "leave this file unchanged");
    symlinkSync(target, file);
    writeCredentials(PAT, file);
    expect(readFileSync(target, "utf8")).toBe("leave this file unchanged");
    expect(lstatSync(file).isSymbolicLink()).toBe(false);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readCredentials(file)).toEqual(PAT);
  });
  it("returns null for a missing file", () => {
    expect(readCredentials(file)).toBeNull();
  });
  it("returns null for a corrupt file", () => {
    writeFileSync(file, "{ not json");
    expect(readCredentials(file)).toBeNull();
  });
  it("clear removes the file and reports whether one existed", () => {
    writeCredentials(PAT, file);
    expect(clearCredentials(file)).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(clearCredentials(file)).toBe(false);
  });
});
describe("resolveConfig precedence", () => {
  it.each([PAT, OAUTH])(
    "uses saved $auth.mode credentials from XDG_CONFIG_HOME as the baseline",
    (credentials) => {
      writeCredentials(credentials);
      expect(existsSync(join(dir, "mattermost-mcp", "credentials.json"))).toBe(true);
      const config = resolveConfig({});
      expect(config.url).toBe(credentials.url);
      expect(config.auth).toEqual(credentials.auth);
    },
  );
  it("lets a real env var override a stored value", () => {
    writeCredentials(PAT);
    const config = resolveConfig({ MM_TOKEN: "env-wins" });
    expect(config.auth).toEqual({ mode: "pat", token: "env-wins" });
  });
  it("treats empty and undefined environment values as unset", () => {
    writeCredentials(PAT);
    const config = resolveConfig({ MM_URL: "", MM_TOKEN: undefined, MM_AUTH_MODE: "" });
    expect(config.url).toBe(PAT.url);
    expect(config.auth).toEqual(PAT.auth);
  });
  it("reuses saved credentials for an equivalent normalized server URL", () => {
    writeCredentials(PAT);
    const config = resolveConfig({ MM_URL: "https://MM.EXAMPLE.COM:443/" });
    expect(config.auth).toEqual(PAT.auth);
  });
  it.each([
    "https://other.example.com",
    "http://mm.example.com",
    "https://mm.example.com:8443",
    "https://mm.example.com/another-instance",
  ])("does not send the saved PAT to a different server: %s", (MM_URL) => {
    writeCredentials(PAT);
    expect(() => resolveConfig({ MM_URL })).toThrow(/MM_TOKEN/);
  });
  it("does not reuse a saved OAuth client secret for a different server", () => {
    writeCredentials(OAUTH);
    expect(() =>
      resolveConfig({
        MM_URL: "https://other.example.com",
        MM_AUTH_MODE: "oauth2",
        MM_CLIENT_ID: "other-client",
      }),
    ).toThrow(/MM_CLIENT_SECRET/);
  });
  it("accepts explicit credentials for a different server", () => {
    writeCredentials(OAUTH);
    const config = resolveConfig({ MM_URL: "https://other.example.com", MM_TOKEN: "other-pat" });
    expect(config.url).toBe("https://other.example.com");
    expect(config.auth).toEqual({ mode: "pat", token: "other-pat" });
  });
});
