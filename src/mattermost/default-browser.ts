// Resolve the OS default web browser and, if it is Chromium-based, return its
// executable — so `login --gitlab` drives the browser the user actually uses
// (Chrome, Chromium, Brave, Edge, Opera, Vivaldi, Arc, Dia…) instead of always
// Chrome. puppeteer-core can only drive Chromium engines, so non-Chromium
// defaults (Safari, Firefox) return null and the caller falls back to a scan.
//
// All platform probes are best-effort: any failure (command missing, parse error,
// unknown browser) yields null rather than throwing. The exec/which/fs seams are
// injectable so the mapping logic is unit-testable without a real OS.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type RunCapture = (cmd: string, args: string[]) => string | null;
export type WhichLookup = (bin: string) => string | null;

export interface DetectDeps {
  run?: RunCapture;
  which?: WhichLookup;
  fileExists?: (p: string) => boolean;
  env?: Record<string, string | undefined>;
}

function runCapture(cmd: string, args: string[]): string | null {
  try {
    const out = execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.trim() || null;
  } catch {
    return null; // command missing or non-zero exit
  }
}

function whichLookup(bin: string): string | null {
  try {
    return execFileSync("which", [bin], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

// macOS: default-handler bundle id (lowercased) → executable path.
const MAC_BUNDLES: Record<string, string> = {
  "com.google.chrome": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "com.google.chrome.canary":
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "org.chromium.chromium": "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "com.brave.browser": "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "com.brave.browser.nightly":
    "/Applications/Brave Browser Nightly.app/Contents/MacOS/Brave Browser Nightly",
  "com.microsoft.edgemac": "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "com.operasoftware.opera": "/Applications/Opera.app/Contents/MacOS/Opera",
  "com.vivaldi.vivaldi": "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
  "company.thebrowser.browser": "/Applications/Arc.app/Contents/MacOS/Arc",
  "company.thebrowser.dia": "/Applications/Dia.app/Contents/MacOS/Dia",
};

// Linux: xdg-settings .desktop id (lowercased, no suffix) → candidate `which` names.
const LINUX_DESKTOPS: Record<string, string[]> = {
  "google-chrome": ["google-chrome", "google-chrome-stable"],
  "google-chrome-stable": ["google-chrome-stable", "google-chrome"],
  chromium: ["chromium", "chromium-browser"],
  "chromium-browser": ["chromium-browser", "chromium"],
  "brave-browser": ["brave-browser"],
  "brave-browser-stable": ["brave-browser-stable", "brave-browser"],
  "microsoft-edge": ["microsoft-edge", "microsoft-edge-stable"],
  opera: ["opera"],
  "vivaldi-stable": ["vivaldi-stable", "vivaldi"],
};

// Windows: UserChoice ProgId (lowercased) → exe path relative to a program-files root.
const WIN_PROGIDS: Record<string, string> = {
  chromehtml: "Google\\Chrome\\Application\\chrome.exe",
  bravehtml: "BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  msedgehtm: "Microsoft\\Edge\\Application\\msedge.exe",
  operastable: "Opera\\launcher.exe",
  vivaldihtm: "Vivaldi\\Application\\vivaldi.exe",
};

function macDefault(run: RunCapture, fileExists: (p: string) => boolean): string | null {
  const plist = join(
    homedir(),
    "Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist",
  );
  const json = run("plutil", ["-convert", "json", "-o", "-", plist]);
  if (!json) return null;
  let data: { LSHandlers?: { LSHandlerURLScheme?: string; LSHandlerRoleAll?: string }[] };
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  const http = (data.LSHandlers ?? []).find((h) => h.LSHandlerURLScheme === "http");
  const bundle = (http?.LSHandlerRoleAll ?? "").toLowerCase();
  const exe = MAC_BUNDLES[bundle];
  return exe && fileExists(exe) ? exe : null;
}

function linuxDefault(run: RunCapture, which: WhichLookup): string | null {
  const desktop = run("xdg-settings", ["get", "default-web-browser"]);
  if (!desktop) return null;
  const name = desktop.replace(/\.desktop$/i, "").toLowerCase();
  const isChromiumName = /chrom|brave|edge|opera|vivaldi/.test(name);
  const candidates = LINUX_DESKTOPS[name] ?? (isChromiumName ? [name] : []);
  for (const bin of candidates) {
    const found = which(bin);
    if (found) return found;
  }
  return null;
}

function winDefault(
  env: Record<string, string | undefined>,
  run: RunCapture,
  fileExists: (p: string) => boolean,
): string | null {
  const out = run("reg", [
    "query",
    "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice",
    "/v",
    "ProgId",
  ]);
  if (!out) return null;
  const match = out.match(/ProgId\s+REG_SZ\s+(\S+)/i);
  const rel = WIN_PROGIDS[(match?.[1] ?? "").toLowerCase()];
  if (!rel) return null;
  const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(
    (r): r is string => Boolean(r),
  );
  for (const root of roots) {
    const path = `${root}\\${rel}`;
    if (fileExists(path)) return path;
  }
  return null;
}

/**
 * Path to the OS default browser's executable when it is Chromium-based, else null.
 * Never throws — every probe degrades to null so the caller can fall back.
 */
export function defaultChromiumExecutable(
  platform: string = process.platform,
  deps: DetectDeps = {},
): string | null {
  const run = deps.run ?? runCapture;
  const which = deps.which ?? whichLookup;
  const fileExists = deps.fileExists ?? existsSync;
  const env = deps.env ?? process.env;
  try {
    if (platform === "darwin") return macDefault(run, fileExists);
    if (platform === "linux") return linuxDefault(run, which);
    if (platform === "win32") return winDefault(env, run, fileExists);
  } catch {
    return null;
  }
  return null;
}
