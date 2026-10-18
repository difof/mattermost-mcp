import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCredentials } from "../credentials.js";
import { tokenCacheFile, writeTokenCache } from "../mattermost/oauth.js";
import { runLogin } from "./login.js";

const input = vi.hoisted(() => ({ prompt: vi.fn(), promptSecret: vi.fn(), select: vi.fn() }));
const listener = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("Unexpected new OAuth consent");
  }),
);
vi.mock("../prompt.js", () => input);
vi.mock("node:http", () => ({ createServer: listener }));

let directory;
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

it("uses the same normalized server for OAuth cache lookup, verification, and saved login", async () => {
  directory = mkdtempSync(join(tmpdir(), "mm-login-test-"));
  vi.stubEnv("XDG_CONFIG_HOME", directory);
  const url = "https://mm.example.com/mattermost";
  const auth = {
    mode: "oauth2",
    clientId: "client",
    clientSecret: "dummy-secret",
    redirect: "http://127.0.0.1:7000/callback",
  };
  writeTokenCache(tokenCacheFile(url, auth.clientId), {
    accessToken: "cached",
    tokenType: "Bearer",
  });
  input.prompt
    .mockResolvedValueOnce("HTTPS://MM.EXAMPLE.COM:443/mattermost/api/v4/")
    .mockResolvedValueOnce(auth.clientId)
    .mockResolvedValueOnce("");
  input.promptSecret.mockResolvedValue(auth.clientSecret);
  input.select.mockResolvedValue("oauth2");
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const fetch = vi.fn(async () => Response.json({ id: "me", username: "alice" }));
  vi.stubGlobal("fetch", fetch);

  await runLogin();

  expect(listener).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0][0]).toBe(`${url}/api/v4/users/me`);
  expect(new Headers(fetch.mock.calls[0][1].headers).get("authorization")).toBe("BEARER cached");
  expect(readCredentials()).toEqual({ url, auth });
});
