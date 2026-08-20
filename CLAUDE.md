# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An OpenAI-compatible API gateway whose "providers" are not HTTP APIs but AI tools
already running on the user's own machines: logged-in web chat tabs in a real
browser (driven via Playwright/CDP) and local coding CLIs (`claude`, `opencode`)
spawned as child processes. A caller sends a normal `/v1/chat/completions`
request; the gateway routes it over a WebSocket to whichever connected client
agent can serve that model, and streams the answer back as OpenAI-shaped SSE.

It is a monorepo of three npm workspaces plus a protocol contract between two
processes that never share memory:

- **Gateway** (`packages/server`) — stateless about *how* an answer is
  produced; knows only capability ids and slot counts.
- **Client agent** (`packages/client`) — stateless about *who is asking*;
  knows only jobs. Runs on the machine that has the browser/CLIs.
- **Shared** (`packages/shared`) — the WebSocket protocol types and the
  OpenAI response-shape builders both sides depend on.

Read `docs/ARCHITECTURE.md` (per-file map of both packages, design decisions
and *why*) and `docs/PROTOCOL.md` (the exact WebSocket message contract) before
making non-trivial changes to either side — the split only stays correct if
both processes agree on the protocol version and message shapes.

Runs on **Node ≥22** with native TypeScript type-stripping — there is no build
step; source `.ts` files are executed directly (`node packages/server/src/main.ts`).

## Commands

```bash
npm install                # also restores the executable bit on scripts/*.sh (postinstall.mjs)

npm start                   # gateway + client agent, backgrounded (scripts/run.sh)
npm run status              # what each connected agent can currently serve
npm run logs                # follow both processes' logs
npm stop
npm run chrome              # launch Chrome with a debug port for the browser backend
npm run smoke                # exercise the whole API against a running gateway
MODEL=cli/opencode npm run smoke
BASE=http://host:8787 MODEL=web/chatgpt npm run smoke

npm run typecheck            # tsc --noEmit across every package and test
npm test                     # unit + integration (vitest.config.ts)
npm run test:e2e             # real Chromium + real CLIs + official openai SDK (vitest.e2e.config.ts)
```

Run a single test file or test by name with vitest directly:

```bash
npx vitest run tests/unit/router.test.ts
npx vitest run -t "some test name"
npx vitest run --config vitest.e2e.config.ts tests/e2e/cli.e2e.test.ts
```

To run the two processes by hand instead of `scripts/run.sh` (useful when
iterating):

```bash
AIGW_AGENT_TOKEN=my-secret node packages/server/src/main.ts
./scripts/chrome-debug.sh                                    # sign in to providers here, once
AIGW_SERVER_URL=ws://127.0.0.1:8787/agent AIGW_AGENT_TOKEN=my-secret node packages/client/src/main.ts
```

All configuration is environment variables — see `.env.example` for the full,
annotated list (ports, timeouts, routing strategy, cache TTL, browser/CLI
enable flags, etc). There are no separate config files to edit.

## Architecture notes that span files

**Model id = capability id.** `web/chatgpt`, `cli/claude`, `cli/claude:opus`
(sub-model via colon), etc. `GET /v1/models` only ever lists what is *currently
reachable* — capabilities are pushed by the client on change (tab closed/opened,
CLI installed/removed), not polled, and the gateway keeps a short-TTL memo that
is invalidated on connect/change.

**Routing is pure.** `packages/server/src/hub/router.ts` takes a list of
connected clients and returns a pick with no I/O, which is why routing
strategies (`least-busy` default, `round-robin`, `fill-first`) and slot
accounting are unit-tested without a socket. Keep new routing logic pure for
the same reason.

**Settle detection is pure.** `packages/client/src/browser/settle.ts` has no
Playwright import on purpose — it's the piece most likely to be subtly wrong
(quiet-window settle, stall watchdog, "Thinking…" placeholder is not an
answer, deltas never poisoned by transient text), so it's kept directly
testable in isolation from the executor that drives the real page.

**Attach, never launch.** The browser executor connects to a Chrome the user
already started (`connectOverCDP`) and never calls `browser.close()` over CDP —
that call would kill the user's real browser session. Never add a code path
that closes the browser.

**Adding a web provider** = add a row to `packages/client/src/browser/providers.ts`
(selectors for `composer`, `assistant`, `stop`, optional `send`/`signedOut`).
Everything else — send/retry, delta streaming, settle, stall reload — is generic.

**Adding a CLI adapter** = add an entry to `packages/client/src/cli/adapters.ts`
declaring the binary, how argv is built, how the prompt is delivered
(argument vs stdin), and how output is parsed (plain text, or JSONL with a
delta/final extractor).

**SQLite schema is declarative, not migration files.**
`packages/server/src/db/schema.ts` is the single source of truth; any column
added there is applied via `ALTER TABLE ADD COLUMN` on next boot
(`packages/server/src/db/index.ts`). Add columns there, not via a new
migration mechanism. On every boot, all `clients` rows are forced offline and
capabilities to unavailable — a restart must never leave the DB claiming a
not-yet-reconnected client is still serving traffic.

**Errors keep their identity.** When a retryable backend failure exhausts the
candidate list, the caller must see the backend's error (502/504), not a
generic "no active client" (503) — running out of retry candidates must not
mask the real cause. The regression test for this is
`tests/integration/resilience.test.ts`; preserve this behavior when touching
dispatch/failover logic.

**Cache correctness.** Cache keys hash model + full message list + sampling
params. The two-tier cache (in-process LRU in front of a SQLite table) must
replay cached answers correctly over SSE even for callers that requested
streaming. `"cache": false` in a request body bypasses it.

**Protocol version is enforced at the handshake.** `PROTOCOL_VERSION` in
`packages/shared/src/protocol.ts` is checked on `register`; a mismatch closes
the socket (code `4002`) rather than letting an incompatible client half-work.
Bump it deliberately when changing message shapes, and update
`docs/PROTOCOL.md` alongside.

## Tests

- **Unit** (`tests/unit`) — routing strategies/slot accounting, cache
  tiers/TTL/LRU, SQLite schema creation + additive migration, settle/stall/delta
  logic, OpenAI response shapes. No sockets, no browser, no processes.
- **Integration** (`tests/integration`) — a real gateway with scripted fake
  clients over the real WebSocket: discovery, hot capability updates,
  streaming/non-streaming, cache hit/miss, API-key auth, persistence, and the
  full failure matrix (failover, terminal vs retryable errors, attempt limits,
  client vanishing mid-job, dispatch-ack timeout, heartbeat eviction, reconnect
  supersession, concurrency limits).
- **E2E** (`tests/e2e`) — the whole stack for real: a real Chromium against a
  local page reproducing a provider's DOM contract, the actual `claude`/`opencode`
  binaries when installed/authenticated (plus the deterministic `cli/echo`
  adapter otherwise), a gateway restart under a live client to prove reconnect,
  and the official `openai` npm SDK driving everything end to end. The browser
  E2E needs a Chromium reachable via `PLAYWRIGHT_BROWSERS_PATH`,
  `~/.cache/ms-playwright`, a system path, or `AIGW_TEST_CHROME`.

## Deployment

`.github/workflows/deploy.yml` runs on every push to `main`: `npm ci` +
`npm run typecheck` + `npm test` gate a deploy job that pushes the repo to a
single remote server over SSH (`SERVER_ACCOUNT`/`SERVER_IP`/`SERVER_PASS`
secrets) and restarts it as a systemd service.

- `scripts/deploy-push.sh` — runs on the CI runner (or locally with the same
  env vars). Tars the repo (excluding `node_modules`, `.git`, `docs`, `tests`,
  local DB files, `.env`), scp's it to `/opt/llm-gateway` on the server,
  preserves the server's existing `.env` across the swap (copied from the
  previous deploy, never overwritten by the tarball), and invokes
  `deploy-server.sh` remotely. Supports `DRY_RUN=1` for a local no-SSH dry run.
- `scripts/deploy-server.sh` — runs as root on the server. Idempotent:
  installs Node 22+ if missing, `npm ci --omit=dev`, creates `.env` from
  `.env.example` on first deploy only, writes/updates the `llm-gateway.service`
  systemd unit (`ExecStart=node packages/server/src/main.ts`), restarts it, and
  polls `/health` for up to 30s before failing the deploy. Supports `--check`
  to validate prerequisites and print the would-be unit file without touching
  the system — useful for testing changes to the script itself.

The server-side pipeline above only ever pushes `packages/server` to a
company-owned box. The client agent has a separate, parallel rollout story —
see the next section — because it runs on *employees'* own machines, next to
*their* browser/CLIs, not on infrastructure the company controls the same way.

## Client Agent Rollout

For an internal, company-wide pool of client agents (many employees each
contributing a browser session and/or CLI logins to the shared gateway),
`scripts/install-agent.sh` (macOS/Linux) / `scripts/install-agent.ps1`
(Windows) bootstrap Node 22+ if needed and hand off to
`scripts/install-agent.mjs`, which is consent-gated and idempotent:

- Prints a consent notice and requires explicit acceptance **before ever
  opening Chrome** — the notice explains the dedicated, isolated Chrome
  profile (never the employee's personal one) and that whatever they log
  into there becomes usable by the shared gateway pool.
- Auto-installs `claude`/`opencode` CLIs if missing
  (`scripts/install-clis.mjs`, reusing `BUILTIN_ADAPTERS` from
  `packages/client/src/cli/adapters.ts` as the source of truth for bin names
  — never hardcode them a second time).
- Registers the client agent and the dedicated Chrome-debug process as
  OS-native autostart entries (systemd `--user` on Linux, a `LaunchAgent` on
  macOS, a Scheduled Task on Windows) so an employee never has to reopen
  either process by hand.
- `--check` previews every action with no writes (mirrors
  `deploy-server.sh --check`); `--uninstall` removes only the autostart
  entries, never the Chrome profile/agent-id/`.env`, unless `--purge-data` is
  also passed.

No new "call a provider API directly with a key" backend exists or is
needed: `cli/opencode` already reaches 40+ providers (including free tiers)
once an employee runs `opencode auth login <provider>` once — the CLI
backend already covers it.

**Known, deliberately deferred limitation:** every agent still authenticates
with one shared `AIGW_AGENT_TOKEN` (`packages/server/src/hub/hub.ts:87-92`
does a flat string compare against one process-wide value; the `clients`
table has no per-client secret column at all). One leaked employee token
cannot be revoked without rotating it for every other agent too. Per-agent
tokens would require a schema + protocol change (checking the token against
`agentId` inside the `register` handler rather than at HTTP-upgrade time,
since `agentId` isn't known yet at upgrade) and are intentionally out of
scope here — full detail in `docs/CLIENT_ROLLOUT.md`.

**Never build a "quota exhausted -> auto-create a new key/account" fallback.**
This was explicitly considered and rejected: it's sybil-account behavior
against a provider's free-tier rate limiting, not a routing feature. The
existing router/failover (`packages/server/src/http/chat.ts:167`) already
spreads load across whichever real, employee-authenticated clients are
connected — that's the entire scaling mechanism, and it only grows by
consenting employees adding real logins, never by fabricating new ones.

## Security notes

- The agent WebSocket requires `AIGW_AGENT_TOKEN` — change it from the default
  before exposing the gateway beyond localhost.
- `/v1/*` is open unless `AIGW_REQUIRE_API_KEY=true`.
- The client agent spawns local coding CLIs with the user's real credentials
  and drives their logged-in browser sessions — it should only run on machines
  the user controls, with `AIGW_CLI_CWD` pointed at the intended project.
