import { describe, expect, it } from "vitest";
import { resolveChromePath } from "./browser.js";

const never = (): boolean => false;
const noWhich = (): string | null => null;
const noDefault = (): string | null => null;

describe("resolveChromePath", () => {
  it("honors MM_CHROME_PATH when the file exists", () => {
    const path = resolveChromePath(
      { MM_CHROME_PATH: "/opt/chrome" },
      "linux",
      (p) => p === "/opt/chrome",
      noWhich,
      noDefault,
    );
    expect(path).toBe("/opt/chrome");
  });

  it("prefers MM_CHROME_PATH over PUPPETEER_EXECUTABLE_PATH and CHROME_PATH", () => {
    const path = resolveChromePath(
      { MM_CHROME_PATH: "/a", PUPPETEER_EXECUTABLE_PATH: "/b", CHROME_PATH: "/c" },
      "linux",
      () => true,
      noWhich,
      noDefault,
    );
    expect(path).toBe("/a");
  });

  it("throws when the env-provided path is missing", () => {
    expect(() =>
      resolveChromePath({ MM_CHROME_PATH: "/nope" }, "linux", never, noWhich, noDefault),
    ).toThrow(/does not exist/);
  });

  it("prefers the OS default browser over the candidate scan", () => {
    const brave = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
    const path = resolveChromePath(
      {},
      "darwin",
      () => true,
      noWhich,
      () => brave,
    );
    expect(path).toBe(brave);
  });

  it("lets MM_CHROME_PATH win over the default browser", () => {
    const path = resolveChromePath(
      { MM_CHROME_PATH: "/x" },
      "darwin",
      () => true,
      noWhich,
      () => "/brave",
    );
    expect(path).toBe("/x");
  });

  it("falls back to candidates when the default browser is not installed", () => {
    const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const path = resolveChromePath(
      {},
      "darwin",
      (p) => p === chrome,
      noWhich,
      () => "/gone",
    );
    expect(path).toBe(chrome);
  });

  it("returns the first existing macOS candidate", () => {
    const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const path = resolveChromePath({}, "darwin", (p) => p === chrome, noWhich, noDefault);
    expect(path).toBe(chrome);
  });

  it("builds Windows candidates from program-files roots", () => {
    const exe = "C:\\PF\\Google\\Chrome\\Application\\chrome.exe";
    const path = resolveChromePath(
      { PROGRAMFILES: "C:\\PF" },
      "win32",
      (p) => p === exe,
      noWhich,
      noDefault,
    );
    expect(path).toBe(exe);
  });

  it("falls back to a PATH lookup on Linux", () => {
    const path = resolveChromePath(
      {},
      "linux",
      never,
      (bin) => (bin === "chromium" ? "/usr/bin/chromium" : null),
      noDefault,
    );
    expect(path).toBe("/usr/bin/chromium");
  });

  it("throws a helpful error when no browser is found", () => {
    expect(() => resolveChromePath({}, "linux", never, noWhich, noDefault)).toThrow(
      /MM_CHROME_PATH/,
    );
  });
});
