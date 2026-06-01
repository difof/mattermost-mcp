import { describe, expect, it } from "vitest";
import { resolveChromePath } from "./browser.js";

const never = (): boolean => false;
const noWhich = (): string | null => null;

describe("resolveChromePath", () => {
  it("honors MM_CHROME_PATH when the file exists", () => {
    const path = resolveChromePath(
      { MM_CHROME_PATH: "/opt/chrome" },
      "linux",
      (p) => p === "/opt/chrome",
      noWhich,
    );
    expect(path).toBe("/opt/chrome");
  });

  it("prefers MM_CHROME_PATH over PUPPETEER_EXECUTABLE_PATH and CHROME_PATH", () => {
    const path = resolveChromePath(
      { MM_CHROME_PATH: "/a", PUPPETEER_EXECUTABLE_PATH: "/b", CHROME_PATH: "/c" },
      "linux",
      () => true,
      noWhich,
    );
    expect(path).toBe("/a");
  });

  it("throws when the env-provided path is missing", () => {
    expect(() => resolveChromePath({ MM_CHROME_PATH: "/nope" }, "linux", never, noWhich)).toThrow(
      /does not exist/,
    );
  });

  it("returns the first existing macOS candidate", () => {
    const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const path = resolveChromePath({}, "darwin", (p) => p === chrome, noWhich);
    expect(path).toBe(chrome);
  });

  it("builds Windows candidates from program-files roots", () => {
    const exe = "C:\\PF\\Google\\Chrome\\Application\\chrome.exe";
    const path = resolveChromePath({ PROGRAMFILES: "C:\\PF" }, "win32", (p) => p === exe, noWhich);
    expect(path).toBe(exe);
  });

  it("falls back to a PATH lookup on Linux", () => {
    const path = resolveChromePath({}, "linux", never, (bin) =>
      bin === "chromium" ? "/usr/bin/chromium" : null,
    );
    expect(path).toBe("/usr/bin/chromium");
  });

  it("throws a helpful error when no browser is found", () => {
    expect(() => resolveChromePath({}, "linux", never, noWhich)).toThrow(/MM_CHROME_PATH/);
  });
});
