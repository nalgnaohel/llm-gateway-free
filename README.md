# llm-gateway

An OpenAI-compatible API gateway whose "providers" are not HTTP APIs but **the AI
tools already running on your own machines** — web chat sessions in your browser
and coding CLIs in your shell.

```
                                                        ┌──────────────────────────────┐
  OpenAI client                                         │  Client Agent (your machine) │
  (SDK / curl / Cursor / Cline)                         │                              │
        │                                               │   BrowserExecutor            │
        │  POST /v1/chat/completions                    │     └─ Playwright over CDP ──┼──▶ Chrome tab
        ▼                                               │        (ChatGPT, Claude,     │    (your logged-in
  ┌──────────────────────────┐    WebSocket /agent      │         Gemini, DeepSeek…)   │     session)
  │   Gateway Server         │◀────────────────────────▶│                              │
  │                          │   job.request            │   CliExecutor                │
  │  • OpenAI REST surface   │   job.chunk (stream)     │     └─ child_process ────────┼──▶ claude / opencode
  │  • Router + failover     │   job.done / job.error   │                              │
  │  • SQLite + cache        │   heartbeat  ◀───────────│   heartbeat every 10s        │
  └──────────────────────────┘                          └──────────────────────────────┘
```

Request flow, exactly as specified:

1. A caller sends an OpenAI request to the gateway.
2. The gateway finds the **active clients** that advertise the requested model.
3. It dispatches the job to the best one over the open WebSocket.
4. The client checks whether that capability is a **web AI browser session** or a
   **coding CLI**, and runs it accordingly.
5. Output streams back chunk by chunk and is re-emitted as OpenAI SSE.

---

## What's built on top of the two reference projects

| Idea | Source | How it is used here |
|---|---|---|
| OpenAI-compatible surface, SQLite persistence, routing + fallback across accounts | [`9router-v2`](https://github.com/feril3/9router-v2) | Same endpoint shapes, same SSE contract and error envelope; SQLite is declarative-schema + additive auto-migration; fallback becomes *client* failover instead of *API-key* rotation |
| Driving a real logged-in web chat with Playwright over CDP, selector-per-provider registry, settle/stall detection | [`ai-browser-bridge`](https://github.com/YosefHayim/ai-browser-bridge) | The client's `BrowserExecutor` — same "attach, never launch" policy, same composer/assistant/stop selector contract, same quiet-window settle plus stall watchdog |

The new part is the split: the gateway holds no browser and spawns no process; the
client holds no HTTP surface and no database. They meet on one small, versioned
WebSocket protocol (`packages/shared/src/protocol.ts`).

---

## Layout

```
packages/
  shared/   protocol types + OpenAI response builders (used by both sides)
  server/   gateway: express + ws hub + sqlite + cache + router
  client/   agent: browser executor (Playwright/CDP) + cli executor (spawn)
tests/
  unit/         router, cache, sqlite, settle logic, OpenAI shapes
  integration/  server + scripted fake clients over the real WebSocket
  e2e/          real Chromium, real page, real CLIs, official OpenAI SDK
scripts/
  run.sh              start/status/logs/stop for gateway + agent
  smoke-test.sh       exercise the whole API against a running gateway
  dev.sh              run gateway + agent in the foreground
  chrome-debug.sh     launch Chrome with a debug port on a dedicated profile (POSIX)
  chrome-debug.mjs    same, cross-platform (Linux/macOS/Windows)
  install-agent.sh    employee installer bootstrap (macOS/Linux) — see docs/CLIENT_ROLLOUT.md
  install-agent.ps1   employee installer bootstrap (Windows)
  install-agent.mjs   installer logic: consent, CLI install, autostart
  install-clis.mjs    auto-install claude/opencode CLIs if missing
  postinstall.mjs     restore the executable bit on the shell scripts
```

Runs on **Node 22** with native TypeScript type-stripping — there is no build step.

---

## Quick start

```bash
npm install

npm start           # gateway + client agent in the background
npm run status      # what each connected agent can serve
npm run smoke       # exercise the whole API and print the results
npm run logs        # follow both logs
npm stop
```

The `scripts/*.sh` files are plain POSIX `sh` — `./scripts/run.sh start` and
`sh scripts/run.sh start` both work, including where `/bin/sh` is dash. Copying the
tree without git can drop the executable bit and give you `Permission denied`; the
npm scripts above work regardless, and `npm install` restores the bit via
`scripts/postinstall.mjs`.

To use the **browser** backends, start Chrome with a debug port first and sign in
there once — `npm run chrome`. Web providers appear in `/v1/models` within one
capability-scan interval of a tab being open and logged in.

Rolling a client agent out to other people's machines instead of developing on
this repo? See [`docs/CLIENT_ROLLOUT.md`](./docs/CLIENT_ROLLOUT.md) for a
consent-gated, cross-platform installer (`scripts/install-agent.sh` /
`.ps1`) that auto-installs the CLIs and keeps everything running across
reboots.

Point the smoke test at a specific model or host:

```bash
MODEL=cli/opencode npm run smoke
BASE=http://192.168.1.10:8787 MODEL=web/chatgpt npm run smoke
```

Or run the two processes by hand:

```bash
# terminal 1 — gateway
AIGW_AGENT_TOKEN=my-secret node packages/server/src/main.ts

# terminal 2 — Chrome with a debug port (sign in to ChatGPT/Claude here, once)
./scripts/chrome-debug.sh

# terminal 3 — client agent
AIGW_SERVER_URL=ws://127.0.0.1:8787/agent \
AIGW_AGENT_TOKEN=my-secret \
node packages/client/src/main.ts
```

The agent prints what it found:

```
✓ web/mockweb        Mock Web LLM (test)
· web/chatgpt        ChatGPT (web) — no open tab for this provider
✓ cli/claude         Claude Code CLI 2.1.235
✓ cli/opencode       OpenCode CLI 1.18.18
```

Then use it like any OpenAI endpoint:

```bash
curl http://127.0.0.1:8787/v1/models

curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"cli/claude","messages":[{"role":"user","content":"hello"}]}'

curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"web/chatgpt","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="not-required")
print(client.chat.completions.create(
    model="cli/claude", messages=[{"role": "user", "content": "hello"}]
).choices[0].message.content)
```

---

## Model naming

A model id **is** a capability id. Sub-models are addressed with a colon.

| Model | Backend |
|---|---|
| `web/chatgpt`, `web/claude`, `web/gemini`, `web/deepseek`, `web/grok`, `web/perplexity`, `web/duck` | an open, logged-in tab in your Chrome |
| `cli/claude`, `cli/claude:opus`, `cli/claude:sonnet`, `cli/claude:haiku` | `claude -p` |
| `cli/opencode` | `opencode run` |
| `cli/echo` | deterministic test adapter (`AIGW_CLI_EXTRA=echo`) |
| `web/mockweb` | local test page with the same DOM contract as a real provider |

`GET /v1/models` only lists what is **currently reachable**. Close a ChatGPT tab and
`web/chatgpt` disappears within one capability-scan interval; reopen it and it comes
back — no restart on either side.

---

## API

### OpenAI-compatible

| Endpoint | Notes |
|---|---|
| `GET /v1/models`, `GET /v1/models/:id` | live capability union across all connected clients |
| `POST /v1/chat/completions` | streaming and non-streaming; `stream_options`-style usage is included on the final chunk |

Extension: `"cache": false` in the body forces a fresh call for that request.

Response headers: `x-aigw-request-id`, `x-aigw-cache` (`hit`/`miss`), `x-aigw-client`.

### Operations

| Endpoint | Notes |
|---|---|
| `GET /health` | clients, online capabilities, active jobs, cache stats |
| `GET /api/clients` | live sockets **and** the persisted history |
| `GET /api/capabilities` | aggregated capability view with free slots |
| `GET /api/requests?limit=50` | recent requests |
| `GET /api/usage` | totals and per-model rollup |
| `GET /api/cache`, `DELETE /api/cache` | cache stats / flush |

---

## How the pieces work

### Connection and health check

The client opens one WebSocket to `/agent` with `Authorization: Bearer <AIGW_AGENT_TOKEN>`
and sends `register` with its capability list. From then on it sends a `heartbeat`
every `AIGW_HEARTBEAT_INTERVAL_MS`. The server sweeps on the same interval and evicts
any client whose last heartbeat is older than `interval × AIGW_HEARTBEAT_MISS_TOLERANCE`,
marking it offline in SQLite and failing its in-flight jobs as *retryable* so they
re-route rather than die.

The client reconnects on its own with exponential backoff and jitter
(`AIGW_RECONNECT_BASE_MS` → `AIGW_RECONNECT_MAX_MS`). Because the agent id is stable
and persisted, a reconnect reuses the same database row, and a second socket for the
same agent id supersedes the first instead of creating a duplicate.

Capabilities are re-probed every `AIGW_CAPABILITY_SCAN_MS` and pushed **only when
something changed**, so a closed tab or a newly installed CLI shows up in `/v1/models`
without a restart.

### Routing and failover

`least-busy` (default), `round-robin`, or `fill-first`, chosen with
`AIGW_ROUTING_STRATEGY`. Candidates must have a free slot both on the capability and
on the client as a whole. If a job fails with a *retryable* error the gateway excludes
that client and retries on another, up to `AIGW_MAX_ROUTE_ATTEMPTS`. A client that
never acknowledges a dispatched job within `AIGW_DISPATCH_ACK_TIMEOUT_MS` is treated
the same way.

When a request arrives for a model no one currently serves, the gateway waits up to
`AIGW_QUEUE_WAIT_MS` for a client to appear before returning 503 — which is what makes
"start the gateway first, agents later" work.

### SQLite and caching

`better-sqlite3` in WAL mode. The schema is declarative
(`packages/server/src/db/schema.ts`): tables are created from it and any column added
later is applied with `ALTER TABLE ADD COLUMN` on the next boot, so upgrades need no
migration files. Tables: `clients`, `capabilities`, `api_keys`, `requests`,
`request_events`, `response_cache`, `meta`.

The response cache is two-tier — an in-process LRU in front of a SQLite table, so a
gateway restart keeps warm entries. Keys hash the model, the full message list and the
sampling parameters. Cached answers are replayed over SSE too, so a streaming caller
still gets a well-formed stream. `/v1/models` has its own short-TTL memo that is
invalidated the moment a client connects or changes capabilities.

### Browser backend

Playwright `connectOverCDP` against a Chrome you started yourself — the agent
**attaches, never launches**, and never calls `browser.close()`, so your browser is
never killed. Each provider contributes only selectors (`composer`, `assistant`,
`stop`, optional `send`/`signedOut`); everything else is generic:

- send with retries until the composer clears, never on top of an in-flight answer;
- watch the last assistant node and stream the newly appended text as deltas;
- treat "Thinking…"-style placeholders as *not* an answer, and never let them poison
  the delta baseline;
- settle when the stop control is gone and the text has been quiet for 1.2s;
- reload the tab at most twice if rendering stalls for 3 minutes.

Adding a provider means adding a row to `packages/client/src/browser/providers.ts`.

### CLI backend

Each adapter (`packages/client/src/cli/adapters.ts`) declares a binary, how to build
its argv, how the prompt is delivered (argument or stdin), and how to read its output
(plain text, or JSONL with a delta/final extractor). `claude` uses
`--output-format stream-json --include-partial-messages` so tokens stream as they are
produced; `opencode` uses `run --format json`.

---

## Configuration

Every setting is an environment variable; see [`.env.example`](./.env.example) for the
annotated list.

---

## Tests

```bash
npm run typecheck # tsc --noEmit across every package and test
npm test          # unit + integration  (84 tests)
npm run test:e2e  # end to end          (24 tests)
```

**Unit** — routing strategies and slot accounting, cache tiers/TTL/LRU, SQLite schema
creation and additive migration, the settle/stall/delta logic, OpenAI response shapes.

**Integration** — a real gateway with scripted fake clients over the real WebSocket:
model discovery and hot capability updates, streaming and non-streaming completions,
cache hit/miss, API-key auth, SQLite persistence, and the failure matrix — failover to
a second client, terminal vs. retryable errors, attempt limits, a client vanishing
mid-job, dispatch-ack timeout, heartbeat eviction, reconnect supersession, and
concurrency limits.

**E2E** — the whole stack for real:

- `browser.e2e.test.ts` launches a real Chromium on a debug port with a local page that
  reproduces the DOM contract of a real provider, and drives it through the gateway;
- `cli.e2e.test.ts` spawns the actual `claude` and `opencode` binaries when they are
  installed and authenticated, and always exercises the deterministic `cli/echo`;
- `full-stack.e2e.test.ts` runs both backends on one agent and restarts the gateway
  underneath a live client to prove reconnect;
- `sdk-compat.e2e.test.ts` drives everything through the official `openai` npm package.

The browser E2E needs a Chromium; it looks in `PLAYWRIGHT_BROWSERS_PATH`,
`~/.cache/ms-playwright`, and the usual system paths, or set `AIGW_TEST_CHROME`.

---

## Security notes

- The agent WebSocket requires `AIGW_AGENT_TOKEN`. Change it from the default before
  exposing the gateway beyond localhost.
- `/v1/*` is open unless `AIGW_REQUIRE_API_KEY=true`. Turn it on for anything reachable
  off-box.
- The client agent spawns local coding CLIs with your credentials and drives your
  logged-in browser sessions. Run it only on machines you control, and point
  `AIGW_CLI_CWD` at the project you actually want those CLIs to touch.
