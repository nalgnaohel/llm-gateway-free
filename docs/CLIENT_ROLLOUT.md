# Client Agent Rollout

How to roll the client agent out to many employee machines so a company can
pool its available AI tools (logged-in web chat sessions, coding CLIs) behind
one shared gateway. This is a parallel, separate story from
[the gateway server's own deploy pipeline](../CLAUDE.md#deployment) — that
one pushes `packages/server` to a company-owned box; this one runs on
employees' own machines, next to their own browser/CLIs.

This is an **opt-in, consent-gated** rollout. An employee runs the installer
themselves (or IT hands it to them to run) — it is never a silent background
push, and it never touches a Chrome profile or account the employee didn't
choose to use for this.

## Install

```bash
# macOS / Linux
AIGW_REPO_URL=<internal git remote for this repo> \
AIGW_AGENT_TOKEN=<the gateway's shared AIGW_AGENT_TOKEN> \
./scripts/install-agent.sh

# Windows (PowerShell)
$env:AIGW_REPO_URL = "<internal git remote for this repo>"
$env:AIGW_AGENT_TOKEN = "<the gateway's shared AIGW_AGENT_TOKEN>"
.\scripts\install-agent.ps1
```

`AIGW_REPO_URL` must point at wherever this repo is actually hosted
internally (this doc deliberately doesn't hardcode a URL). `AIGW_AGENT_TOKEN`
must match the target gateway's `AIGW_AGENT_TOKEN` — the installer writes it
into `~/.ai-gateway-client/app/.env` (mode `0600`) so every autostart entry
picks it up, on this run and every reboot after. It only needs to be passed
once per machine: a rerun with no `AIGW_AGENT_TOKEN` set reuses whatever is
already saved in that `.env`, and a rerun *with* a new value (e.g. rotating
a leaked token) overwrites it and restarts the running units so the change
takes effect immediately. `config.ts`'s built-in default server URL already
points at the shared gateway; only pass `AIGW_SERVER_URL` too if routing this
machine somewhere else. Missing the token entirely (no env var, no prior
`.env`) is a hard error — it never silently falls back to the source's dev
default and registers as an agent the real gateway will just reject.

Preview everything the installer would do without changing anything on the
machine:

```bash
AIGW_REPO_URL=<...> AIGW_AGENT_TOKEN=<...> ./scripts/install-agent.sh --check
```

## What it does, in order

1. Bootstraps Node 22+ if missing — **no sudo/apt**, since an employee laptop
   user usually isn't root: `brew`/`nvm` on macOS/Linux, `winget`/nvm-windows
   on Windows.
2. Clones (first run) or `pull --ff-only`s (rerun) this repo into
   `~/.ai-gateway-client/app`, then persists `AIGW_AGENT_TOKEN` (and
   `AIGW_SERVER_URL` if given) into that directory's `.env`, then
   `npm ci --omit=dev`.
3. Auto-installs `claude`/`opencode` CLIs if not already on `PATH`
   (`scripts/install-clis.mjs`), via `npm install -g @anthropic-ai/claude-code`
   / `npm install -g opencode-ai`. If a CLI install fails (commonly an npm
   global-prefix permission issue), it prints the real error plus a
   remediation hint and moves on — CLI support is optional, the browser
   backend alone is still enough for the installer to succeed.
4. Shows a consent notice and **requires explicit acceptance** (typing
   `yes`, or `--yes` / `AIGW_CONSENT_ACCEPTED=1` for an IT-scripted rollout —
   which still always prints the notice for an audit trail, it only skips the
   interactive wait) before ever touching Chrome. Full text below.
5. First run only: launches the dedicated Chrome profile in the foreground
   so the employee can log into whatever they choose (ChatGPT, Claude.ai,
   Gemini, ...), then waits for them to close the window. Reruns skip this
   entirely once the profile directory exists.
6. Registers OS-native autostart for **both** the client agent process and
   the Chrome-debug process, so neither needs to be reopened by hand again:
   systemd `--user` units on Linux, a `LaunchAgent` on macOS, a Scheduled
   Task on Windows.

## Consent notice (verbatim)

```
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
        ~/.ai-gateway-client/chrome-profile
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
    agent nay bat cu luc nao - xem muc "Uninstall / pause" o day.

 4. Agent nay cung tu cai claude/opencode CLI neu may chua co, va
    se de BAN tu dang nhap chung theo cach binh thuong
    (opencode auth login / dang nhap tuong tac cua claude) - no
    khong bao gio tu tao tai khoan hay API key thay ban.
================================================================
```

## Autostart entries this installer writes

**Linux** — `~/.config/systemd/user/aigw-client-agent.service` and
`aigw-chrome.service`, enabled via
`systemctl --user enable --now aigw-client-agent aigw-chrome`. Both
`Restart=always`. Only starts once the employee logs into a desktop
session — a headless Linux box never gets `loginctl enable-linger` from this
installer (that needs elevated privilege on some distros), so it will only
ever offer `cli/*` capabilities, never `web/*`.

**macOS** — `~/Library/LaunchAgents/com.aigw.client-agent.plist` and
`com.aigw.chrome.plist`, loaded via `launchctl bootstrap`. `KeepAlive=true`
is the `Restart=always` equivalent — **if the employee manually closes the
Chrome window, launchd reopens it.** Use `npm run stop:agent` (see below) to
pause instead of fighting the supervisor by repeatedly closing the window.

**Windows** — two Scheduled Tasks (`AIGW Client Agent`, `AIGW Chrome Debug`)
triggered `AtLogOn` (a login-triggered task, not a Windows Service, since
Chrome needs the interactive desktop session), pointing at self-looping
`run-client-agent.cmd`/`run-chrome.cmd` wrappers under the app directory
(Task Scheduler's own restart-count has a practical cap, so the wrappers
loop themselves and check a `stop.flag` sentinel to exit cleanly).

## Uninstall / pause

```bash
npm run stop:agent          # pause both processes without uninstalling
npm run uninstall:agent     # remove autostart entries only
npm run uninstall:agent -- --purge-data   # also wipe chrome-profile/, agent-id, .env
```

`--uninstall` (without `--purge-data`) never touches the Chrome profile,
the persisted `agent-id`, or `.env` — rerunning the installer afterward
reuses the same logged-in profile, no re-login needed.

Verified on a real Linux install: `--uninstall` removed both systemd `--user`
units while leaving `agent-id`, `.consent-v1-accepted` and `chrome-profile/`
byte-for-byte unchanged; re-running the installer afterward printed
`Chrome profile already exists - skipping first-login step.` and came back
up with the same previously-logged-in capabilities (`web/*`, `cli/*`)
without any re-authentication.

## Known limitations

- **Headless Linux machines only ever get `cli/*` capabilities** — the
  browser backend needs a real desktop session for Chrome, which this
  installer doesn't attempt to fake.
- **Auto-restart will reopen a manually-closed Chrome window** (macOS
  `KeepAlive`, Linux `Restart=always`, Windows's self-looping wrapper) — use
  `npm run stop:agent` to pause, not closing the window.
- **One shared `AIGW_AGENT_TOKEN` for every agent.** The server's upgrade
  check (`packages/server/src/hub/hub.ts:87-92`) is a flat string compare
  against a single process-wide value; the `clients` table
  (`packages/server/src/db/schema.ts`) has no per-client secret column.
  Leaking one employee's installed token can't be revoked without rotating
  it for every other agent — rotating means re-running the installer on
  every machine with the new `AIGW_AGENT_TOKEN` (it overwrites the saved
  `.env` value and restarts the running units), which is still an
  every-machine operation, just no longer a manual SSH-and-edit-`.env` one.
  Per-agent tokens are a deliberately separate, future change — it needs a
  schema addition and a protocol change (the token would have to be checked
  against `agentId` inside the `register` message handler instead of at
  HTTP-upgrade time, since `agentId` isn't known yet at upgrade).
- **No auto-provisioned API keys, and this is intentional.** If an employee
  wants a free-tier model beyond what a CLI login already gives them, they
  run `opencode auth login <provider>` themselves, once, with their own real
  account. Nothing in this installer creates accounts or keys on anyone's
  behalf — doing so automatically when a quota is exhausted was considered
  and explicitly rejected, since it amounts to sybil-account abuse of a
  provider's free-tier rate limiting rather than a routing feature.
