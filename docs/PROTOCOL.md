# Gateway ⇄ Client Agent protocol (v1)

One WebSocket per client agent, JSON text frames, defined in
`packages/shared/src/protocol.ts`. `PROTOCOL_VERSION` is checked at registration and a
mismatch closes the socket with code `4002` — a client from a different release can
never half-work.

## Handshake

```
client → GET /agent            Authorization: Bearer <AIGW_AGENT_TOKEN>
                               (or ?token=… for clients that cannot set headers)
client → register              { protocolVersion, agentId, name, version, platform,
                                 capabilities[], maxConcurrency, tags[] }
server → registered            { clientId, heartbeatIntervalMs, serverTime }
```

`agentId` is stable and persisted at `<AIGW_CLIENT_DATA_DIR>/agent-id`, so a reconnect
updates the existing `clients` row instead of creating a new one. If the same `agentId`
registers again while an older socket is still open, the older socket is closed with
`4003` and superseded.

A socket that does not `register` within 10s is closed with `4001`.

## Liveness

```
client → heartbeat             { clientTime, activeJobs, cpuLoad?, memMb? }
server → heartbeat.ack         { serverTime, activeJobs }
```

The server sweeps every `AIGW_HEARTBEAT_INTERVAL_MS`. A client whose last heartbeat is
older than `interval × AIGW_HEARTBEAT_MISS_TOLERANCE` is evicted: marked offline in
SQLite, its capabilities marked unavailable, its in-flight jobs failed as *retryable*
so they re-route, and the socket closed with `4004`.

## Capabilities

```
client → capabilities          { capabilities: Capability[] }
```

Sent whenever a re-probe finds a difference — a tab opened or closed, a CLI installed
or removed, a session signed out. The server replaces the client's rows wholesale and
invalidates the `/v1/models` memo.

```ts
type Capability = {
  id: string;            // also the OpenAI model name: "web/chatgpt", "cli/claude"
  kind: "browser" | "cli";
  provider: string;      // "chatgpt", "claude", "opencode", …
  displayName: string;
  available: boolean;    // false = present but unusable right now
  reason?: string;       // why not, for diagnostics
  concurrency: number;   // parallel jobs this capability accepts
  models?: string[];     // sub-models, addressed as "<id>:<sub>"
};
```

## Jobs

```
server → job.request           { jobId, capabilityId, model?, messages[], stream,
                                 temperature?, maxTokens?, stopSequences?,
                                 timeoutMs, requestId }
client → job.accepted          { jobId }
client → job.chunk             { jobId, delta, index }        (streaming only)
client → job.done              { jobId, content, usage?, finishReason? }
client → job.error             { jobId, code, message, retryable }
server → job.cancel            { jobId, reason }
```

- `job.accepted` must arrive within `AIGW_DISPATCH_ACK_TIMEOUT_MS` or the job is failed
  as retryable and re-routed to another client.
- `content` in `job.done` is authoritative. If a client streamed chunks and the final
  content extends them, the gateway flushes the remainder; if it streamed nothing, the
  gateway emits the whole answer as one delta. Callers therefore always receive the
  complete text whether or not the backend can stream.
- `retryable` is the client's judgement. A closed tab or a crashed CLI is retryable; a
  cancellation or an authentication failure is not. The gateway excludes the client and
  retries only while `retryable` is true and attempts remain.
- A backend error is reported to the caller as 502 (or 504 on timeout) **even when no
  other client is left to retry on** — running out of candidates must not mask the real
  cause behind a 503.

## Error codes

| Code | Meaning |
|---|---|
| `DISPATCH_TIMEOUT` | client never acknowledged the job |
| `JOB_TIMEOUT` | job exceeded its budget |
| `CLIENT_DISCONNECTED` | socket dropped mid-job |
| `CLIENT_TIMEOUT` | evicted for missed heartbeats |
| `BACKEND_TIMEOUT` | the browser/CLI backend itself timed out |
| `BACKEND_MISSING` | the CLI binary is not on PATH |
| `BROWSER_UNAVAILABLE` | no reachable Chrome, or no tab for that provider |
| `NOT_AUTHENTICATED` | the web session is signed out |
| `BACKEND_ERROR` | anything else the backend reported |
| `CANCELLED` | cancelled by the server or the caller |
