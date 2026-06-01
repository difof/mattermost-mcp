import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  StoredCredentialsSchema,
  readCredentials,
  writeCredentials,
  clearCredentials,
  credentialsToEnv,
  resolveConfig,
  type StoredCredentials,
} from "./credentials.js";
import { loadConfig } from "./config.js";

const dir = mkdtempSync(join(tmpdir(), "mm-cred-"));
const file = join(dir, "credentials.json");

afterEach(() => {
  try {
    rmSync(file);
  } catch {
    // already gone
  }
});

const PAT: StoredCredentials = {
  url: "https://mm.example.com",
  auth: { mode: "pat", token: "tok-123" },
};
const OAUTH: StoredCredentials = {
  url: "https://mm.example.com",
  auth: {
    mode: "oauth2",
    clientId: "cid",
    clientSecret: "secret",
    redirect: "http://127.0.0.1:7000/callback",
  },
};

describe("StoredCredentialsSchema", () => {
  it("accepts pat and oauth2 shapes", () => {
    expect(StoredCredentialsSchema.parse(PAT)).toEqual(PAT);
    expect(StoredCredentialsSchema.parse(OAUTH)).toEqual(OAUTH);
  });

  it("rejects a password mode (never persisted)", () => {
    const bad = { url: "https://mm.example.com", auth: { mode: "password", loginId: "a" } };
    expect(StoredCredentialsSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a non-URL server", () => {
    expect(StoredCredentialsSchema.safeParse({ ...PAT, url: "not-a-url" }).success).toBe(false);
  });
});

describe("write / read / clear", () => {
  it("round-trips credentials through disk", () => {
    writeCredentials(PAT, file);
    expect(readCredentials(file)).toEqual(PAT);
  });

  it("writes the file with 0600 permissions", () => {
    writeCredentials(PAT, file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
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
  it("uses stored credentials as the baseline", () => {
    // Mirrors resolveConfig's merge: loadConfig({ ...stored, ...env }).
    const config = loadConfig({ ...credentialsToEnv(PAT) });
    expect(config.url).toBe("https://mm.example.com");
    expect(config.auth).toEqual({ mode: "pat", token: "tok-123" });
  });

  it("lets a real env var override a stored value", () => {
    const config = loadConfig({ ...credentialsToEnv(PAT), MM_TOKEN: "env-wins" });
    expect(config.auth).toEqual({ mode: "pat", token: "env-wins" });
  });

  it("resolveConfig reads the credentials file via XDG_CONFIG_HOME", () => {
    const prevXdg = process.env.XDG_CONFIG_HOME;
    const xdg = mkdtempSync(join(tmpdir(), "mm-xdg-"));
    process.env.XDG_CONFIG_HOME = xdg;
    try {
      writeCredentials(PAT, join(xdg, "mattermost-mcp", "credentials.json"));
      // Pass an env without MM_* so only the stored credentials apply.
      const config = resolveConfig({});
      expect(config.auth).toEqual({ mode: "pat", token: "tok-123" });
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
      rmSync(xdg, { recursive: true, force: true });
    }
  });
});

describe("credentialsToEnv", () => {
  it("maps a pat to MM_TOKEN", () => {
    expect(credentialsToEnv(PAT)).toEqual({
      MM_URL: "https://mm.example.com",
      MM_AUTH_MODE: "pat",
      MM_TOKEN: "tok-123",
    });
  });

  it("maps oauth2 to client id/secret/redirect", () => {
    expect(credentialsToEnv(OAUTH)).toEqual({
      MM_URL: "https://mm.example.com",
      MM_AUTH_MODE: "oauth2",
      MM_CLIENT_ID: "cid",
      MM_CLIENT_SECRET: "secret",
      MM_OAUTH_REDIRECT: "http://127.0.0.1:7000/callback",
    });
  });
});
