/** OpenAI-compatible request/response shapes + helpers shared by server and tests. */
import type { ChatMessage, JobUsage } from "./protocol.ts";

export type OpenAIChatRequest = {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  stop?: string | string[];
  user?: string;
  /** gateway extension: skip the response cache for this call */
  cache?: boolean;
};

export type OpenAIErrorBody = {
  error: { message: string; type: string; code: string | null; param?: string | null };
};

const ERROR_TYPES: Record<number, { type: string; code: string }> = {
  400: { type: "invalid_request_error", code: "bad_request" },
  401: { type: "invalid_request_error", code: "invalid_api_key" },
  404: { type: "invalid_request_error", code: "model_not_found" },
  408: { type: "timeout_error", code: "request_timeout" },
  429: { type: "rate_limit_error", code: "rate_limit_exceeded" },
  502: { type: "api_error", code: "bad_gateway" },
  503: { type: "api_error", code: "service_unavailable" },
  504: { type: "timeout_error", code: "gateway_timeout" },
};

export function buildErrorBody(status: number, message: string, param?: string): OpenAIErrorBody {
  const info =
    ERROR_TYPES[status] ??
    (status >= 500 ? { type: "api_error", code: "internal_error" } : { type: "invalid_request_error", code: "" });
  return { error: { message, type: info.type, code: info.code || null, param: param ?? null } };
}

export function chatCompletionId(): string {
  return `chatcmpl-${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
}

export function nonStreamingBody(args: {
  id: string;
  model: string;
  content: string;
  usage: JobUsage;
  finishReason?: string;
  systemFingerprint?: string;
}) {
  return {
    id: args.id,
    object: "chat.completion" as const,
    created: Math.floor(Date.now() / 1000),
    model: args.model,
    system_fingerprint: args.systemFingerprint,
    choices: [
      {
        index: 0,
        message: { role: "assistant" as const, content: args.content },
        logprobs: null,
        finish_reason: args.finishReason ?? "stop",
      },
    ],
    usage: {
      prompt_tokens: args.usage.promptTokens,
      completion_tokens: args.usage.completionTokens,
      total_tokens: args.usage.totalTokens,
    },
  };
}

export function streamChunk(args: {
  id: string;
  model: string;
  delta: { role?: "assistant"; content?: string };
  finishReason?: string | null;
  usage?: JobUsage;
}) {
  return {
    id: args.id,
    object: "chat.completion.chunk" as const,
    created: Math.floor(Date.now() / 1000),
    model: args.model,
    choices: [{ index: 0, delta: args.delta, logprobs: null, finish_reason: args.finishReason ?? null }],
    ...(args.usage
      ? {
          usage: {
            prompt_tokens: args.usage.promptTokens,
            completion_tokens: args.usage.completionTokens,
            total_tokens: args.usage.totalTokens,
          },
        }
      : {}),
  };
}

export function sse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export const SSE_DONE = "data: [DONE]\n\n";

/** Cheap heuristic token estimate — browser/CLI backends do not report real usage. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function messagesToPrompt(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === "system") parts.push(`[System instructions]\n${m.content}`);
    else if (m.role === "user") parts.push(m.content);
    else if (m.role === "assistant") parts.push(`[Previous assistant reply]\n${m.content}`);
    else if (m.role === "tool") parts.push(`[Tool result${m.name ? ` from ${m.name}` : ""}]\n${m.content}`);
  }
  return parts.join("\n\n").trim();
}

export function normalizeStop(stop: string | string[] | undefined): string[] | undefined {
  if (!stop) return undefined;
  return Array.isArray(stop) ? stop : [stop];
}
