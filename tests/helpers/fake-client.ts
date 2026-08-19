import WebSocket from "ws";
import { decode, encode, PROTOCOL_VERSION, type Capability, type ServerToClient } from "@aigw/shared";

/**
 * A scriptable stand-in for the real client agent. Integration tests use it to
 * drive the server through paths that are awkward to force with a live backend:
 * failover, dispatch timeouts, heartbeat loss, concurrency limits.
 */
export type FakeClientOptions = {
  url: string;
  token: string;
  agentId: string;
  capabilities: Capability[];
  maxConcurrency?: number;
  /** omit to disable heartbeats and let the server evict this client */
  heartbeat?: boolean;
  /** never send job.accepted, to exercise the dispatch-ack timeout */
  swallowJobs?: boolean;
  /** how a job is answered */
  behavior?: (jobId: string, payload: Record<string, unknown>) => Promise<
    { kind: "done"; chunks?: string[]; content: string } | { kind: "error"; code: string; message: string; retryable: boolean }
  >;
};

export class FakeClient {
  readonly opts: FakeClientOptions;
  ws?: WebSocket;
  registered = false;
  jobsSeen: string[] = [];
  private heartbeatTimer?: NodeJS.Timeout;

  constructor(opts: FakeClientOptions) {
    this.opts = opts;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.opts.url, { headers: { Authorization: `Bearer ${this.opts.token}` } });
      this.ws = ws;
      const failTimer = setTimeout(() => reject(new Error("fake client registration timeout")), 10_000);

      ws.on("open", () => {
        ws.send(
          encode({
            type: "register",
            payload: {
              protocolVersion: PROTOCOL_VERSION,
              agentId: this.opts.agentId,
              name: this.opts.agentId,
              version: "test",
              platform: "test",
              capabilities: this.opts.capabilities,
              maxConcurrency: this.opts.maxConcurrency ?? 4,
            },
          }),
        );
      });

      ws.on("message", (raw) => {
        const msg = decode(String(raw)) as ServerToClient;
        if (msg.type === "registered") {
          this.registered = true;
          clearTimeout(failTimer);
          if (this.opts.heartbeat !== false) {
            this.heartbeatTimer = setInterval(() => {
              if (ws.readyState === WebSocket.OPEN)
                ws.send(encode({ type: "heartbeat", payload: { clientTime: Date.now(), activeJobs: 0 } }));
            }, Math.max(500, msg.payload.heartbeatIntervalMs / 2));
            this.heartbeatTimer.unref?.();
          }
          resolve();
          return;
        }
        if (msg.type === "job.request") {
          this.jobsSeen.push(msg.payload.jobId);
          if (this.opts.swallowJobs) return;
          ws.send(encode({ type: "job.accepted", payload: { jobId: msg.payload.jobId } }));
          void this.answer(msg.payload.jobId, msg.payload as unknown as Record<string, unknown>);
        }
      });

      ws.on("error", (err) => {
        clearTimeout(failTimer);
        reject(err);
      });
    });
  }

  private async answer(jobId: string, payload: Record<string, unknown>): Promise<void> {
    const ws = this.ws!;
    const behavior =
      this.opts.behavior ??
      (async () => ({ kind: "done" as const, chunks: ["hello ", "from ", "fake"], content: "hello from fake" }));
    const result = await behavior(jobId, payload);
    if (ws.readyState !== WebSocket.OPEN) return;
    if (result.kind === "error") {
      ws.send(encode({ type: "job.error", payload: { jobId, code: result.code, message: result.message, retryable: result.retryable } }));
      return;
    }
    let index = 0;
    for (const chunk of result.chunks ?? []) {
      ws.send(encode({ type: "job.chunk", payload: { jobId, delta: chunk, index: index++ } }));
      await new Promise((r) => setTimeout(r, 5));
    }
    ws.send(encode({ type: "job.done", payload: { jobId, content: result.content, finishReason: "stop" } }));
  }

  updateCapabilities(capabilities: Capability[]): void {
    this.ws?.send(encode({ type: "capabilities", payload: { capabilities } }));
  }

  close(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.ws?.close(1000, "test over");
  }
}

export function cap(id: string, overrides: Partial<Capability> = {}): Capability {
  return {
    id,
    kind: id.startsWith("web/") ? "browser" : "cli",
    provider: id.split("/")[1] ?? id,
    displayName: id,
    available: true,
    concurrency: 1,
    ...overrides,
  };
}
