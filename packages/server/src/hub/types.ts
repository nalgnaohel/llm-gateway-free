import type { Capability, ChatMessage, JobUsage } from "@aigw/shared";

export type ConnectedClient = {
  clientId: string;
  name: string;
  version: string;
  platform: string;
  remoteAddr: string;
  maxConcurrency: number;
  capabilities: Map<string, Capability>;
  /** in-flight job ids on this client */
  inflight: Set<string>;
  /** per-capability in-flight counters */
  inflightByCapability: Map<string, number>;
  connectedAt: number;
  lastHeartbeatAt: number;
  heartbeatMisses: number;
  send(msg: unknown): void;
  close(code: number, reason: string): void;
};

export type JobSpec = {
  requestId: string;
  capabilityId: string;
  model?: string;
  messages: ChatMessage[];
  stream: boolean;
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
  timeoutMs: number;
};

export type JobEvent =
  | { type: "accepted"; clientId: string }
  | { type: "chunk"; delta: string; index: number }
  | { type: "done"; content: string; usage?: JobUsage; finishReason?: string }
  | { type: "error"; code: string; message: string; retryable: boolean };

export class GatewayError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.code = code;
  }
}
