# Architecture notes

## Why the split

The gateway is stateless with respect to *how* an answer is produced: it knows only
capability ids and slot counts. The client is stateless with respect to *who is
asking*: it knows only jobs. That boundary is what lets a single gateway serve many
machines — a laptop with a logged-in ChatGPT tab, a workstation with `claude` and
`opencode` installed, a VM with neither — without any of them knowing about each other.

## Gateway

```
packages/server/src/
  main.ts            boot: config → sqlite → cache → hub → express → listen
  config.ts          every knob, all from environment variables
  cache.ts           two-tier response cache + a small TTL memo for /v1/models
  db/
    schema.ts        declarative tables; the single source of truth
    index.ts         open, PRAGMAs, create-if-missing + additive column sync
    repos.ts         all SQL, grouped by table
  hub/
    hub.ts           WebSocket control plane: register, heartbeat, dispatch, settle
    router.ts        candidate selection, strategies, capability aggregation (pure)
    types.ts         ConnectedClient, JobSpec, JobEvent, GatewayError
  http/
    app.ts           express wiring, auth, /health, /v1/models, admin API
    chat.ts          /v1/chat/completions: validate → cache → dispatch → SSE
```

`router.ts` is deliberately pure — it takes clients and returns a pick, with no I/O —
which is why the routing rules can be unit-tested exhaustively without a socket.

On boot every `clients` row is forced to `offline` and every capability to
`available = 0`. A restart must not leave the database claiming that clients which
have not yet reconnected are still serving traffic.

## Client agent

```
packages/client/src/
  main.ts            boot + entry point
  config.ts          environment config; persists a stable agentId
  agent.ts           socket lifecycle, backoff, heartbeat, capability sync, job loop
  browser/
    providers.ts     selector registry — the only per-provider knowledge
    settle.ts        pure completion detection: started / settled / delta / stall
    executor.ts      Playwright over CDP: attach, find tab, inject, watch, extract
  cli/
    adapters.ts      per-CLI argv + output parsing
    executor.ts      spawn, stream stdout, classify failures
    echo-cli.ts      deterministic CLI used by the tests
```

`settle.ts` holds no Playwright import on purpose: completion detection is the part
most likely to be wrong, and keeping it pure makes it directly testable.

## Design decisions worth knowing

**Attach, never launch.** The browser executor connects to an existing Chrome over CDP
and drops only its own websocket on teardown. Playwright's `browser.close()` over CDP
sends `Browser.close`, which would kill the user's browser — so it is never called.

**A placeholder is not an answer.** Web UIs render "Thinking…" into the same node they
later fill with the real reply. Emitting that as a delta would poison the streaming
baseline, because the real answer is not a suffix of it. The executor suppresses
transient text and resyncs when it clears.

**The final text wins.** Deltas are best-effort; `job.done.content` is authoritative.
The gateway reconciles the two so a caller never receives a truncated stream even when
the last poll landed mid-render.

**Errors keep their identity.** When a retryable backend failure exhausts the candidate
list, the caller sees the backend's error (502/504), not "no active client" (503). The
regression test for this lives in `tests/integration/resilience.test.ts`.

**Capability changes are pushed, not polled.** The client diffs its own probe results
and sends `capabilities` only on a real change; the gateway invalidates the model-list
memo on connect/change. `/v1/models` therefore stays cheap under polling clients while
still reflecting a closed tab within one scan interval.
