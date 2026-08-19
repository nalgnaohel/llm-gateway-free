import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Launch a throwaway Chrome/Chromium on a remote-debugging port, so the client
 * agent can attach over CDP exactly the way it attaches to a user's real browser.
 */
export type LaunchedChrome = { cdpUrl: string; port: number; stop(): Promise<void> };

function findChromeBinary(): string {
  const explicit = process.env.AIGW_TEST_CHROME;
  if (explicit && fs.existsSync(explicit)) return explicit;

  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers", path.join(os.homedir(), ".cache/ms-playwright")];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root)) {
      for (const rel of ["chrome-linux/chrome", "chrome-linux/headless_shell", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
        const candidate = path.join(root, entry, rel);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  for (const p of ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error("no Chrome/Chromium binary found for the E2E suite");
}

async function waitForDebugPort(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`chrome debug port ${port} never came up`);
}

export async function launchChrome(startUrl: string): Promise<LaunchedChrome> {
  const bin = findChromeBinary();
  const port = 9500 + Math.floor(Math.random() * 400);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "aigw-chrome-"));
  const child: ChildProcess = spawn(
    bin,
    [
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--headless=new",
      startUrl,
    ],
    { stdio: "ignore", detached: false },
  );

  await waitForDebugPort(port);
  return {
    cdpUrl: `http://127.0.0.1:${port}`,
    port,
    async stop() {
      child.kill("SIGKILL");
      await new Promise((r) => setTimeout(r, 200));
      fs.rmSync(profile, { recursive: true, force: true });
    },
  };
}
