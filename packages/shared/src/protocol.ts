/**
 * Wire protocol between Gateway Server and Client Agent (WebSocket, JSON text frames).
 *
 *   client --(register)-->        server     : announce identity + capabilities
 *   server --(registered)-->      client     : ack + assigned clientId + heartbeat policy
 *   client --(heartbeat)-->       server     : liveness + load metrics (every heartbeatIntervalMs)
 *   server --(heartbeat.ack)-->   client     : server-side clock + backpressure hint
 *   client --(capabilities)-->    server     : hot-swap capability list (tab opened/closed, cli installed)
 *   server --(job.request)-->     client     : execute an inference job
 *   client --(job.accepted)-->    server     : job picked up (used for dispatch timeout)
 *   client --(job.chunk)-->       server     : streaming delta
 *   client --(job.done)-->        server     : final text + usage
 *   client --(job.error)-->       server     : terminal failure (server may fail over to another client)
 *   server --(job.cancel)-->      client     : client disconnected / request aborted
 */

export const PROTOCOL_VERSION = 1;

/** How a capability is fulfilled on the client machine. */
export type BackendKind = "browser" | "cli";

export type Capability = {
  /** Stable id, also the OpenAI `model` name exposed by the gateway. e.g. "web/chatgpt", "cli/claude" */
  id: string;
  kind: BackendKind;
  /** Provider/tool key: chatgpt | claude | gemini | ... | claude-cli | opencode */
  provider: string;
  displayName: string;
  /** false => present but currently unusable (tab closed, not signed in, cli missing) */
  available: boolean;
  /** Why unavailable, for diagnostics. */
  reason?: string;
  /** Max jobs this capability can run at once on the client. */
  concurrency: number;
  /** Optional sub-models the backend can select (browser model picker / cli --model). */
  models?: string[];
};

export type ClientRegisterPayload = {
  protocolVersion: number;
  /** Stable per-machine id so reconnects reuse the same DB row. */
  agentId: string;
  name: string;
  version: string;
  platform: string;
  capabilities: Capability[];
  /** Total concurrent jobs across all capabilities. */
  maxConcurrency: number;
  tags?: string[];
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
};

export type JobRequestPayload = {
  jobId: string;
  capabilityId: string;
  /** Sub-model hint (browser model picker / cli --model). */
  model?: string;
  messages: ChatMessage[];
  stream: boolean;
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
  /** ms; client must emit job.error TIMEOUT past this. */
  timeoutMs: number;
  /** Opaque, echoed back in events for tracing. */
  requestId: string;
};

export type JobUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type ServerToClient =
  | { type: "registered"; payload: { clientId: string; heartbeatIntervalMs: number; serverTime: number } }
  | { type: "heartbeat.ack"; payload: { serverTime: number; activeJobs: number } }
  | { type: "job.request"; payload: JobRequestPayload }
  | { type: "job.cancel"; payload: { jobId: string; reason: string } }
  | { type: "error"; payload: { code: string; message: string } };

export type ClientToServer =
  | { type: "register"; payload: ClientRegisterPayload }
  | { type: "heartbeat"; payload: { clientTime: number; activeJobs: number; cpuLoad?: number; memMb?: number } }
  | { type: "capabilities"; payload: { capabilities: Capability[] } }
  | { type: "job.accepted"; payload: { jobId: string } }
  | { type: "job.chunk"; payload: { jobId: string; delta: string; index: number } }
  | { type: "job.done"; payload: { jobId: string; content: string; usage?: JobUsage; finishReason?: string } }
  | { type: "job.error"; payload: { jobId: string; code: string; message: string; retryable: boolean } };

export type WireMessage = ServerToClient | ClientToServer;

export function encode(msg: WireMessage): string {
  return JSON.stringify(msg);
}

export function decode(raw: string): WireMessage {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") {
    throw new Error("malformed wire message");
  }
  return parsed as WireMessage;
}
