# Progress notes — local client-agent rollout (fork only)

Working notes from bringing up the client agent in production mode on the
developer's own test machine (hostname redacted). Fork-only file — not part
of the PR going to the upstream repo (`tritueviet/llm-gateway-free`), so it
stays on `main` here.

## What's running on this machine

- Gateway: local, started manually via `npm start` (no autostart — this repo
  doesn't ship gateway autostart; that's server-side only, per
  `docs/CLIENT_ROLLOUT.md`). `ws://127.0.0.1:8787/agent`, `dev-agent-token`.
- Client agent + Chrome debug: installed via `scripts/install-agent.sh`
  (production-style), running as `systemd --user` services
  (`aigw-client-agent`, `aigw-chrome`), autostart on login/reboot.
- Capabilities live: `web/chatgpt` ✓, `cli/claude` ✓, `cli/opencode` ✓.

## Fixes made this session (already in PR #1)

`scripts/install-agent.mjs`:
- **Portable PATH for autostart entries.** systemd/launchd/Task Scheduler
  start processes with a minimal PATH that omits nvm/`~/.npm-global`/Homebrew
  bins, so `claude`/`opencode` showed as not-found even though they work
  fine interactively. Now captures the installer's own runtime PATH
  (`runtimePath()`) and bakes it into the systemd unit, the macOS plist, and
  the Windows wrapper.
- **Crash-loop rate limit.** Added `StartLimitIntervalSec=180` /
  `StartLimitBurst=5` to both Linux units. `Restart=always` alone means a
  process the OOM killer keeps reaping restarts in a tight loop that only
  adds more memory/CPU pressure — past the burst, systemd marks the unit
  failed instead of retrying forever. Reset with `systemctl --user
  reset-failed && systemctl --user restart <unit>` once memory is free again.

## Known issue: this machine runs hot on RAM

Observed during testing: 11–13GB/15GB used, swap repeatedly full, `aigw-chrome`
got OOM-killed and auto-restarted 12–20+ times (each restart reopens
`chatgpt.com`, which looked like unexplained tab spam before we traced it).
Root cause is this machine's normal workload (GoLand + Bazel, VS Code, a
personal Chrome with many tabs, multiple concurrent `claude` CLI sessions),
not a gateway bug — a cold Chrome boot alone costs ~700MB–1GB (browser
process, GPU process, network/audio services, zygote, crashpad, renderer),
so restarting it repeatedly on an already-saturated machine keeps re-tripping
the OOM killer. The rate-limit fix above bounds the damage but doesn't fix
the underlying scarcity — that's on the developer to manage (close unused
apps/tabs/CLI sessions, or run `bazel shutdown` between builds) if it keeps
happening. Two divergent Chrome instances (one started manually via
`npm run chrome`, one via the newly-enabled `aigw-chrome.service`) caused the
first burst of duplicate tabs; only ever run one at a time going forward.

## Account note

`cli/claude`'s default profile (`~/.claude`, no `CLAUDE_CONFIG_DIR` override —
distinct from this coding-agent session's own `~/.claude-acc1`) is logged in
as the developer's own company account (email redacted). Per the project's
design (`CLAUDE.md`: client agent "spawns local coding CLIs with the user's
real credentials"), any colleague's request routed to `cli/claude` on this
machine actually spends *this* account's Claude usage — same sharing model
the install consent notice already describes for browser logins. First
login attempt accidentally authenticated a different, personal account
(email redacted) because a browser session for it was already active during
the OAuth redirect; had to log out / use a private window and redo it to
land on the right account.

## Open items / not done

- No gateway autostart on this machine (by design, out of scope for the
  employee installer) — if the `npm start` gateway process dies, the
  production client agent can't reconnect until it's started again by hand.
- No further optimization attempted on Chrome's own baseline memory
  footprint (e.g. `--disable-extensions`, `--disable-background-networking`,
  `--disable-sync`, `--disable-default-apps`, `--metrics-recording-only`) —
  discussed but not applied; would shave some memory but wouldn't fix a
  machine this saturated on its own. Machines already resource-constrained
  are probably better off with `AIGW_BROWSER_ENABLED=false` (CLI-only
  contribution) than fighting for headroom against a full Chrome instance.
