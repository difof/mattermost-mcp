import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCredentials, writeCredentials } from "../credentials.js";
import { credentialsFile } from "../paths.js";
import { tokenCacheFile } from "../mattermost/oauth.js";
import { runLogout } from "./logout.js";

let directory;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "mm-logout-test-"));
  vi.stubEnv("XDG_CONFIG_HOME", directory);
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

describe("logout deletion failures", () => {
  it("retains saved OAuth metadata when the token cache cannot be removed", () => {
    const credentials = {
      url: "https://mm.example.com",
      auth: {
        mode: "oauth2",
        clientId: "client",
        clientSecret: "dummy-secret",
        redirect: "http://127.0.0.1:7000/callback",
      },
    };
    writeCredentials(credentials);
    mkdirSync(tokenCacheFile(credentials.url, credentials.auth.clientId));
    expect(() => runLogout()).toThrow();
    expect(readCredentials()).toEqual(credentials);
    expect(process.stdout.write).not.toHaveBeenCalled();
  });

  it("reports a credential-file removal failure instead of claiming no login exists", () => {
    mkdirSync(credentialsFile(), { recursive: true });
    expect(() => runLogout()).toThrow();
    expect(existsSync(credentialsFile())).toBe(true);
    expect(process.stdout.write).not.toHaveBeenCalled();
  });
});
