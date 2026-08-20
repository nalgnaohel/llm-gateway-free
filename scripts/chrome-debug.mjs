#!/usr/bin/env node
// Cross-platform (Linux/macOS/Windows) equivalent of chrome-debug.sh.
// Launch Chrome with a remote-debugging port on a dedicated profile.
// Sign in to ChatGPT / Claude / Gemini once in THIS window; the client agent
// attaches to it over CDP and reuses those sessions.
//
// Chrome 136+ refuses --remote-debugging-port against the default profile, so a
// separate user-data-dir is mandatory, not a preference.
import { existsSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";

export function findChromeBinary() {
  const candidates = [
    process.env.CHROME_BIN,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
      : undefined,
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p));
}

/** Spawns Chrome and returns the child process; caller decides how to wait on it. */
export function launchChrome({ port, profile, url, stdio = "inherit" } = {}) {
  const cdpPort = port ?? process.env.AIGW_CDP_PORT ?? "9222";
  const profileDir = profile ?? process.env.AIGW_CHROME_PROFILE ?? path.join(os.homedir(), ".ai-gateway-client", "chrome-profile");
  const startUrl = url ?? process.env.AIGW_CHROME_URL ?? "https://chatgpt.com/";
  mkdirSync(profileDir, { recursive: true });

  const bin = findChromeBinary();
  if (!bin) {
    throw new Error("No Chrome found. Set CHROME_BIN=/path/to/chrome");
  }

  console.log(`Launching ${bin} on debug port ${cdpPort}`);
  console.log(`  profile: ${profileDir}`);
  console.log("  sign in to your AI sites in this window; leave the tabs open.");

  return spawn(
    bin,
    [
      `--remote-debugging-port=${cdpPort}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      startUrl,
    ],
    { stdio },
  );
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  let child;
  try {
    child = launchChrome();
  } catch (err) {
    console.error(String(err.message ?? err));
    process.exit(1);
  }
  child.on("exit", (code) => process.exit(code ?? 0));
}
