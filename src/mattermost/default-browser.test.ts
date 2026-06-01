import { describe, expect, it } from "vitest";
import { defaultChromiumExecutable } from "./default-browser.js";

const macPlist = (bundle: string): string =>
  JSON.stringify({ LSHandlers: [{ LSHandlerURLScheme: "http", LSHandlerRoleAll: bundle }] });

describe("defaultChromiumExecutable", () => {
  it("maps a macOS Brave default to its executable (bundle id case-insensitive)", () => {
    const exe = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
    const path = defaultChromiumExecutable("darwin", {
      run: (cmd) => (cmd === "plutil" ? macPlist("com.brave.Browser") : null),
      fileExists: (p) => p === exe,
    });
    expect(path).toBe(exe);
  });

  it("returns null for a non-Chromium macOS default (Firefox)", () => {
    const path = defaultChromiumExecutable("darwin", {
      run: () => macPlist("org.mozilla.firefox"),
      fileExists: () => true,
    });
    expect(path).toBeNull();
  });

  it("returns null when the mapped macOS app is not installed", () => {
    const path = defaultChromiumExecutable("darwin", {
      run: () => macPlist("com.google.chrome"),
      fileExists: () => false,
    });
    expect(path).toBeNull();
  });

  it("maps a Linux Brave default via a PATH lookup", () => {
    const path = defaultChromiumExecutable("linux", {
      run: (cmd) => (cmd === "xdg-settings" ? "brave-browser.desktop" : null),
      which: (bin) => (bin === "brave-browser" ? "/usr/bin/brave-browser" : null),
    });
    expect(path).toBe("/usr/bin/brave-browser");
  });

  it("returns null for a Linux Firefox default", () => {
    const path = defaultChromiumExecutable("linux", {
      run: () => "firefox.desktop",
      which: () => "/usr/bin/firefox",
    });
    expect(path).toBeNull();
  });

  it("maps a Windows Chrome default via the registry ProgId", () => {
    const exe = "C:\\PF\\Google\\Chrome\\Application\\chrome.exe";
    const path = defaultChromiumExecutable("win32", {
      env: { PROGRAMFILES: "C:\\PF" },
      run: () => "    ProgId    REG_SZ    ChromeHTML\n",
      fileExists: (p) => p === exe,
    });
    expect(path).toBe(exe);
  });

  it("returns null when the probe command is unavailable", () => {
    expect(defaultChromiumExecutable("darwin", { run: () => null })).toBeNull();
  });

  it("returns null on unsupported platforms", () => {
    expect(defaultChromiumExecutable("aix", { run: () => "whatever" })).toBeNull();
  });
});
