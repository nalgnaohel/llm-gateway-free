#!/usr/bin/env node
// Employee client-agent installer. Consent-gated, idempotent, cross-platform
// (Linux/macOS/Windows). Run via scripts/install-agent.sh (macOS/Linux) or
// scripts/install-agent.ps1 (Windows), which only ensure Node 22+ first.
//
//   AIGW_REPO_URL=<internal git remote> node scripts/install-agent.mjs [--check|--uninstall [--purge-data]|--stop]
//
// See docs/CLIENT_ROLLOUT.md for the full walkthrough and known limitations.
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import readline from "node:readline/promises";
import os from "node:os";
import path from "node:path";

const CONSENT_VERSION = "v1";
const dataDir = process.env.AIGW_CLIENT_DATA_DIR ?? path.join(os.homedir(), ".ai-gateway-client");
const appDir = path.join(dataDir, "app");
const consentFile = path.join(dataDir, `.consent-${CONSENT_VERSION}-accepted`);
const stopFlag = path.join(appDir, "stop.flag");

const args = process.argv.slice(2);
const flags = {
  check: args.includes("--check"),
  uninstall: args.includes("--uninstall"),
  purgeData: args.includes("--purge-data"),
  yes: args.includes("--yes"),
  stop: args.includes("--stop"),
};

function requireNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) {
    console.error(`Node ${process.versions.node} found, but this installer needs Node 22+.`);
    process.exit(1);
  }
}

function run(cmd, cmdArgs, opts = {}) {
  const res = spawnSync(cmd, cmdArgs, {
    stdio: "inherit",
    shell: process.platform === "win32",
    ...opts,
  });
  if (res.error) throw res.error;
  return res.status ?? 0;
}

const CONSENT_TEXT = `
================================================================
 AI Gateway - Cai dat Client Agent
================================================================
Viec nay cai 1 agent chay nen, cho phep gateway noi bo dung cac
cong cu AI da co san tren MAY NAY (CLI lap trinh va/hoac 1 phien
dang nhap web chat) khi ban khong dung den, de phuc vu dong nghiep
khac qua cung 1 gateway.

Truoc khi tiep tuc, xin doc ky:

 1. Buoc nay se mo Google Chrome tren 1 PROFILE HOAN TOAN MOI,
    TACH BIET, luu tai:
        ${path.join(dataDir, "chrome-profile")}
    Day KHONG phai Chrome ban dung hang ngay - no khong thay,
    khong chia se, khong anh huong gi toi profile ca nhan, lich su,
    hay cac tab khac ban dang mo.

 2. Bat ky thu gi ban dang nhap trong CUA SO RIENG do (ChatGPT,
    Claude.ai, Gemini...) se duoc gateway dung chung - nghia la
    request cua dong nghiep co the chay qua phien dang nhap do cua
    ban, y het cach no chay qua CLI claude/opencode ban da tu
    dang nhap.

 3. Ban tu quyet dinh dang nhap gi trong cua so do. Khong dang nhap
    gi thi chi CLI cuc bo (neu co) duoc dung. Co the tam dung/go
    agent nay bat cu luc nao - xem docs/CLIENT_ROLLOUT.md, muc
    "Uninstall / pause".

 4. Agent nay cung tu cai claude/opencode CLI neu may chua co, va
    se de BAN tu dang nhap chung theo cach binh thuong
    (opencode auth login / dang nhap tuong tac cua claude) - no
    khong bao gio tu tao tai khoan hay API key thay ban.
================================================================
`;

async function ensureConsent() {
  console.log(CONSENT_TEXT);
  if (flags.check) {
    console.log(existsSync(consentFile) ? "[check] consent already accepted on a previous run" : "[check] would wait for consent acceptance here");
    return;
  }
  if (existsSync(consentFile)) {
    console.log("(already accepted on a previous run)");
    return;
  }
  if (flags.yes || process.env.AIGW_CONSENT_ACCEPTED === "1") {
    console.log('(accepted non-interactively via --yes / AIGW_CONSENT_ACCEPTED=1)');
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('Go "yes" de tiep tuc, hoac Ctrl-C de huy: ');
    rl.close();
    if (answer.trim().toLowerCase() !== "yes") {
      console.error("Cancelled.");
      process.exit(1);
    }
  }
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(consentFile, new Date().toISOString());
}

function getSource() {
  const repoUrl = process.env.AIGW_REPO_URL;
  const gitDir = path.join(appDir, ".git");

  if (!repoUrl) {
    console.error("AIGW_REPO_URL is not set - point it at this repo's internal git remote and re-run.");
    process.exit(1);
  }

  if (flags.check) {
    console.log(
      existsSync(gitDir)
        ? `[check] would run: git -C ${appDir} pull --ff-only`
        : `[check] would run: git clone --depth 1 ${repoUrl} ${appDir}`,
    );
    return;
  }

  mkdirSync(dataDir, { recursive: true });
  if (existsSync(gitDir)) {
    run("git", ["-C", appDir, "pull", "--ff-only"]);
  } else {
    run("git", ["clone", "--depth", "1", repoUrl, appDir]);
  }
}

function npmCi() {
  if (flags.check) {
    console.log(`[check] would run: npm ci --omit=dev (cwd=${appDir})`);
    return;
  }
  run("npm", ["ci", "--omit=dev"], { cwd: appDir });
}

async function installClis() {
  if (flags.check) {
    console.log("[check] would probe/install claude + opencode CLIs (scripts/install-clis.mjs)");
    return;
  }
  const mod = await import(pathToFileURL(path.join(appDir, "scripts", "install-clis.mjs")).href);
  const results = await mod.installClis();
  console.log(JSON.stringify(results, null, 2));
}

async function firstLogin() {
  const profileDir = process.env.AIGW_CHROME_PROFILE ?? path.join(dataDir, "chrome-profile");
  if (existsSync(profileDir)) {
    console.log("Chrome profile already exists - skipping first-login step.");
    return;
  }
  if (flags.check) {
    console.log(`[check] would launch scripts/chrome-debug.mjs for first login (no profile yet at ${profileDir})`);
    return;
  }
  console.log("Opening Chrome for first-time login. Sign in, then close the window to continue.");
  run(process.execPath, [path.join(appDir, "scripts", "chrome-debug.mjs")]);
}

// ------------------------------------------------------------- autostart --

function nodeBin() {
  return process.execPath;
}

function linuxUnits() {
  const node = nodeBin();
  return {
    "aigw-client-agent.service": `[Unit]
Description=AI Gateway Client Agent
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${appDir}
EnvironmentFile=-${appDir}/.env
ExecStart=${node} ${appDir}/packages/client/src/main.ts
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`,
    "aigw-chrome.service": `[Unit]
Description=AI Gateway dedicated Chrome (debug profile)
After=graphical-session.target

[Service]
Type=simple
EnvironmentFile=-${appDir}/.env
ExecStart=${node} ${appDir}/scripts/chrome-debug.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`,
  };
}

function installLinuxAutostart() {
  const unitDir = path.join(os.homedir(), ".config", "systemd", "user");
  const units = linuxUnits();
  if (flags.check) {
    console.log(`[check] would write units to ${unitDir}:`);
    for (const [name, content] of Object.entries(units)) console.log(`--- ${name} ---\n${content}`);
    console.log("[check] would run: systemctl --user daemon-reload && systemctl --user enable --now aigw-client-agent aigw-chrome");
    return;
  }
  mkdirSync(unitDir, { recursive: true });
  for (const [name, content] of Object.entries(units)) writeFileSync(path.join(unitDir, name), content);
  run("systemctl", ["--user", "daemon-reload"]);
  run("systemctl", ["--user", "enable", "--now", "aigw-client-agent", "aigw-chrome"]);
}

function uninstallLinuxAutostart() {
  run("systemctl", ["--user", "disable", "--now", "aigw-client-agent", "aigw-chrome"]);
  const unitDir = path.join(os.homedir(), ".config", "systemd", "user");
  for (const name of ["aigw-client-agent.service", "aigw-chrome.service"]) {
    const p = path.join(unitDir, name);
    if (existsSync(p)) rmSync(p);
  }
  run("systemctl", ["--user", "daemon-reload"]);
}

function macPlist(label, execPath) {
  const node = nodeBin();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>set -a; [ -f "${appDir}/.env" ] &amp;&amp; . "${appDir}/.env"; set +a; exec ${node} ${execPath}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${path.join(dataDir, "client-agent.log")}</string>
  <key>StandardErrorPath</key><string>${path.join(dataDir, "client-agent.log")}</string>
</dict></plist>
`;
}

function macPlists() {
  return {
    "com.aigw.client-agent.plist": macPlist("com.aigw.client-agent", `${appDir}/packages/client/src/main.ts`),
    "com.aigw.chrome.plist": macPlist("com.aigw.chrome", `${appDir}/scripts/chrome-debug.mjs`),
  };
}

function macUid() {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

function installMacAutostart() {
  const agentDir = path.join(os.homedir(), "Library", "LaunchAgents");
  const plists = macPlists();
  if (flags.check) {
    console.log(`[check] would write plists to ${agentDir}:`);
    for (const [name, content] of Object.entries(plists)) console.log(`--- ${name} ---\n${content}`);
    return;
  }
  mkdirSync(agentDir, { recursive: true });
  const uid = macUid();
  for (const [name, content] of Object.entries(plists)) {
    const p = path.join(agentDir, name);
    writeFileSync(p, content);
    const label = name.replace(/\.plist$/, "");
    spawnSync("launchctl", ["bootout", `gui/${uid}/${label}`]); // ignore: not loaded yet on first install
    run("launchctl", ["bootstrap", `gui/${uid}`, p]);
    run("launchctl", ["enable", `gui/${uid}/${label}`]);
  }
}

function uninstallMacAutostart() {
  const uid = macUid();
  const agentDir = path.join(os.homedir(), "Library", "LaunchAgents");
  for (const label of ["com.aigw.client-agent", "com.aigw.chrome"]) {
    spawnSync("launchctl", ["bootout", `gui/${uid}/${label}`]);
    const p = path.join(agentDir, `${label}.plist`);
    if (existsSync(p)) rmSync(p);
  }
}

function windowsWrapper(entryRelPath) {
  const node = nodeBin();
  return `@echo off
cd /d "%~dp0"
:loop
if exist "stop.flag" exit /b 0
if exist ".env" for /f "usebackq tokens=1,* delims==" %%A in (".env") do set "%%A=%%B"
"${node}" ${entryRelPath}
timeout /t 5 /nobreak >nul
goto loop
`;
}

function installWindowsAutostart() {
  const files = {
    "run-client-agent.cmd": windowsWrapper("packages\\client\\src\\main.ts"),
    "run-chrome.cmd": windowsWrapper("scripts\\chrome-debug.mjs"),
  };
  if (flags.check) {
    console.log("[check] would write run-*.cmd into the app dir and register 2 Scheduled Tasks (AtLogOn trigger, RestartCount=999):");
    for (const [name, content] of Object.entries(files)) console.log(`--- ${name} ---\n${content}`);
    return;
  }
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(appDir, name), content);

  const register = (taskName, cmdName) => `
$action = New-ScheduledTaskAction -Execute '${path.join(appDir, cmdName)}'
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName '${taskName}' -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited -Force
`;
  run("powershell", ["-NoProfile", "-Command", register("AIGW Client Agent", "run-client-agent.cmd")]);
  run("powershell", ["-NoProfile", "-Command", register("AIGW Chrome Debug", "run-chrome.cmd")]);
}

function uninstallWindowsAutostart() {
  writeFileSync(stopFlag, "");
  for (const taskName of ["AIGW Client Agent", "AIGW Chrome Debug"]) {
    spawnSync("powershell", [
      "-NoProfile",
      "-Command",
      `Unregister-ScheduledTask -TaskName '${taskName}' -Confirm:$false -ErrorAction SilentlyContinue`,
    ]);
  }
}

function installAutostart() {
  if (existsSync(stopFlag)) rmSync(stopFlag);
  if (process.platform === "linux") installLinuxAutostart();
  else if (process.platform === "darwin") installMacAutostart();
  else if (process.platform === "win32") installWindowsAutostart();
  else {
    console.error(`Unsupported platform: ${process.platform}`);
    process.exit(1);
  }
}

function uninstallAutostart() {
  if (process.platform === "linux") uninstallLinuxAutostart();
  else if (process.platform === "darwin") uninstallMacAutostart();
  else if (process.platform === "win32") uninstallWindowsAutostart();
}

function stopOnly() {
  if (process.platform === "linux") {
    run("systemctl", ["--user", "stop", "aigw-client-agent", "aigw-chrome"]);
  } else if (process.platform === "darwin") {
    const uid = macUid();
    spawnSync("launchctl", ["bootout", `gui/${uid}/com.aigw.client-agent`]);
    spawnSync("launchctl", ["bootout", `gui/${uid}/com.aigw.chrome`]);
  } else if (process.platform === "win32") {
    writeFileSync(stopFlag, "");
  }
}

// ------------------------------------------------------------------ main --

async function main() {
  requireNode();

  if (flags.stop) {
    stopOnly();
    console.log("Stopped. Autostart entries are still registered - run again without --stop, or reboot, to resume.");
    return;
  }

  if (flags.uninstall) {
    uninstallAutostart();
    if (flags.purgeData) {
      if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
      console.log(`Removed ${dataDir} (chrome profile, agent id, .env, everything).`);
    } else {
      console.log("Autostart removed. Chrome profile, agent-id and .env left untouched (pass --purge-data to remove those too).");
    }
    return;
  }

  getSource();
  npmCi();
  await installClis();
  await ensureConsent();
  await firstLogin();
  installAutostart();

  if (flags.check) console.log("\ncheck mode ok - nothing was changed.");
  else console.log("\nDone. Client agent + Chrome will now start automatically at login and survive reboots.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
