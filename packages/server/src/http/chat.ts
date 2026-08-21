import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import {
  buildErrorBody,
  chatCompletionId,
  estimateTokens,
  nonStreamingBody,
  normalizeStop,
  sse,
  SSE_DONE,
  streamChunk,
  type ChatMessage,
  type JobUsage,
  type OpenAIChatRequest,
} from "@aigw/shared";
import type { AgentHub } from "../hub/hub.ts";
import { GatewayError, type JobEvent } from "../hub/types.ts";
import { resolveModel } from "../hub/router.ts";
import type { ResponseCache } from "../cache.ts";
import { cacheKey } from "../cache.ts";
import * as repos from "../db/repos.ts";
import type { Db } from "../db/index.ts";
import type { ServerConfig } from "../config.ts";
import { logger } from "../log.ts";

const log = logger("chat");

export type ChatDeps = { db: Db; hub: AgentHub; cache: ResponseCache; cfg: ServerConfig };

function validate(body: unknown): OpenAIChatRequest {
  if (!body || typeof body !== "object") throw new GatewayError(400, "bad_request", "request body must be a JSON object");
  const b = body as Record<string, unknown>;
  if (typeof b.model !== "string" || !b.model) throw new GatewayError(400, "bad_request", "`model` is required");
  if (!Array.isArray(b.messages) || b.messages.length === 0)
    throw new GatewayError(400, "bad_request", "`messages` must be a non-empty array");
  const messages: ChatMessage[] = [];
  for (const raw of b.messages as unknown[]) {
    const m = raw as Record<string, unknown>;
    const role = m?.role;
    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool")
      throw new GatewayError(400, "bad_request", `unsupported message role: ${String(role)}`);
    const content =
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? (m.content as Array<Record<string, unknown>>)
              .map((part) => (typeof part?.text === "string" ? part.text : ""))
              .join("")
          : "";
    messages.push({ role, content, name: typeof m.name === "string" ? m.name : undefined });
  }
  return {
    model: b.model,
    messages,
    stream: b.stream === true,
    temperature: typeof b.temperature === "number" ? b.temperature : undefined,
    max_tokens: typeof b.max_tokens === "number" ? b.max_tokens : undefined,
    stop: (b.stop as string | string[] | undefined) ?? undefined,
    cache: b.cache === undefined ? undefined : b.cache === true,
  };
}

type Outcome =
  | { ok: true; content: string; usage: JobUsage; clientId: string; capabilityId: string; attempts: number; finishReason?: string }
  | { ok: false; status: number; code: string; message: string; attempts: number };

/**
 * Run the job against the best client, failing over to another client while the
 * error is retryable and attempts remain. `onChunk` streams deltas as they land;
 * on failover the caller is told to reset whatever it already emitted.
 */
async function runWithFailover(
  deps: ChatDeps,
  spec: {
    requestId: string;
    capabilityId: string;
    subModel?: string;
    messages: ChatMessage[];
    stream: boolean;
    temperature?: number;
    maxTokens?: number;
    stop?: string[];
    callerIp?: string;
  },
  onChunk?: (delta: string) => void,
  onFailover?: (attempt: number, reason: string) => void,
): Promise<Outcome> {
  const excluded = new Set<string>();
  let attempts = 0;
  let lastError = { status: 503, code: "no_active_client", message: "no client available" };
  /** Once a backend has actually answered with a failure, that error is the
   *  truth to report — running out of *other* clients to retry on must not
   *  overwrite it with a misleading 503. */
  let sawBackendError = false;

  while (attempts < deps.cfg.maxRouteAttempts) {
    attempts += 1;
    let dispatched: { jobId: string; clientId: string; emitter: import("node:events").EventEmitter };
    try {
      dispatched = deps.hub.dispatch(
        {
          requestId: spec.requestId,
          capabilityId: spec.capabilityId,
          model: spec.subModel,
          messages: spec.messages,
          stream: spec.stream,
          temperature: spec.temperature,
          maxTokens: spec.maxTokens,
          stopSequences: spec.stop,
          timeoutMs: deps.cfg.jobTimeoutMs,
          callerIp: spec.callerIp,
        },
        excluded,
      );
    } catch (err) {
      if (err instanceof GatewayError) {
        if (!sawBackendError) lastError = { status: err.status, code: err.code, message: err.message };
        break;
      }
      throw err;
    }

    repos.addRequestEvent(deps.db, spec.requestId, "dispatch", {
      attempt: attempts,
      clientId: dispatched.clientId,
      jobId: dispatched.jobId,
    });

    const result = await new Promise<JobEvent>((resolve) => {
      let buffer = "";
      dispatched.emitter.on("event", (ev: JobEvent) => {
        if (ev.type === "chunk") {
          buffer += ev.delta;
          onChunk?.(ev.delta);
          return;
        }
        if (ev.type === "done") {
          // Some backends only send the full text; some only send chunks.
          resolve({ ...ev, content: ev.content || buffer });
          return;
        }
        if (ev.type === "error") resolve(ev);
      });
    });

    if (result.type === "done") {
      const promptTokens = estimateTokens(spec.messages.map((m) => m.content).join("\n"));
      const completionTokens = result.usage?.completionTokens ?? estimateTokens(result.content);
      const usage: JobUsage = result.usage ?? {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      };
      return {
        ok: true,
        content: result.content,
        usage,
        clientId: dispatched.clientId,
        capabilityId: spec.capabilityId,
        attempts,
        finishReason: result.finishReason,
      };
    }

    if (result.type === "error") {
      repos.addRequestEvent(deps.db, spec.requestId, "job_error", { attempt: attempts, code: result.code, message: result.message });
      sawBackendError = true;
      lastError = { status: result.code === "JOB_TIMEOUT" ? 504 : 502, code: result.code, message: result.message };
      if (!result.retryable || attempts >= deps.cfg.maxRouteAttempts) break;
      excluded.add(dispatched.clientId);
      onFailover?.(attempts, `${result.code}: ${result.message}`);
      log.warn(`job failed on ${dispatched.clientId} (${result.code}), failing over`);
      continue;
    }
  }

  return { ok: false, status: lastError.status, code: lastError.code, message: lastError.message, attempts };
}

export async function handleChatCompletions(deps: ChatDeps, req: Request, res: Response): Promise<void> {
  const requestId = randomUUID();
  const startedAt = Date.now();
  let body: OpenAIChatRequest;
  try {
    body = validate(req.body);
  } catch (err) {
    const ge = err instanceof GatewayError ? err : new GatewayError(400, "bad_request", String(err));
    res.status(ge.status).json(buildErrorBody(ge.status, ge.message));
    return;
  }

  const { capabilityId, subModel } = resolveModel(body.model);
  const stream = body.stream === true;
  const apiKey = (res.locals.apiKey as string | undefined) ?? null;
  const callerIp = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  repos.createRequest(deps.db, { id: requestId, model: body.model, stream, apiKey });

  const stop = normalizeStop(body.stop);
  const key = cacheKey({
    model: body.model,
    messages: body.messages,
    temperature: body.temperature,
    maxTokens: body.max_tokens,
    stop,
  });
  const cacheable = body.cache !== false;

  /* ---------------------------------------------------------- cache hit */
  if (cacheable) {
    const hit = deps.cache.get(key);
    if (hit) {
      repos.finishRequest(deps.db, requestId, {
        status: "ok",
        cacheHit: true,
        latencyMs: Date.now() - startedAt,
        usage: hit.usage,
        attempts: 0,
      });
      const id = chatCompletionId();
      if (!stream) {
        res.setHeader("x-aigw-cache", "hit");
        res.setHeader("x-aigw-request-id", requestId);
        res.json(nonStreamingBody({ id, model: body.model, content: hit.content, usage: hit.usage }));
        return;
      }
      openSseHeaders(res, requestId, "hit");
      res.write(sse(streamChunk({ id, model: body.model, delta: { role: "assistant", content: "" } })));
      res.write(sse(streamChunk({ id, model: body.model, delta: { content: hit.content } })));
      res.write(sse(streamChunk({ id, model: body.model, delta: {}, finishReason: "stop", usage: hit.usage })));
      res.write(SSE_DONE);
      res.end();
      return;
    }
  }

  /* ---------------------------------------- wait for a capable client */
  if (!deps.hub.hasCapability(capabilityId)) {
    const appeared = await deps.hub.waitForCapability(capabilityId, deps.cfg.queueWaitMs);
    if (!appeared) {
      const message = `no active client provides model "${body.model}"`;
      repos.finishRequest(deps.db, requestId, {
        status: "error",
        errorCode: "no_active_client",
        errorMessage: message,
        latencyMs: Date.now() - startedAt,
        attempts: 0,
      });
      res.status(503).setHeader("x-aigw-request-id", requestId);
      res.json(buildErrorBody(503, message, "model"));
      return;
    }
  }

  const id = chatCompletionId();

  /* ------------------------------------------------------------ streaming */
  if (stream) {
    openSseHeaders(res, requestId, "miss");
    let sentRole = false;
    let emitted = "";
    let aborted = false;
    // Note: `req.on("close")` fires as soon as the request body has been consumed,
    // which is immediately for a POST. Only the *response* closing early means the
    // caller actually went away.
    res.on("close", () => {
      if (!res.writableEnded) aborted = true;
    });

    const outcome = await runWithFailover(
      deps,
      { requestId, capabilityId, subModel, messages: body.messages, stream: true, temperature: body.temperature, maxTokens: body.max_tokens, stop, callerIp },
      (delta) => {
        if (aborted) return;
        if (!sentRole) {
          res.write(sse(streamChunk({ id, model: body.model, delta: { role: "assistant", content: "" } })));
          sentRole = true;
        }
        emitted += delta;
        res.write(sse(streamChunk({ id, model: body.model, delta: { content: delta } })));
      },
      (_attempt, reason) => {
        // A failover after partial output would duplicate text; tell the client
        // we are restarting the answer instead of silently concatenating.
        if (emitted) {
          res.write(
            sse(streamChunk({ id, model: body.model, delta: { content: `\n\n[gateway] retrying on another client (${reason})\n\n` } })),
          );
          emitted = "";
        }
      },
    );

    if (outcome.ok) {
      // Non-streaming backends resolve with the whole answer and no chunks.
      if (!sentRole) {
        res.write(sse(streamChunk({ id, model: body.model, delta: { role: "assistant", content: "" } })));
        sentRole = true;
      }
      if (!emitted && outcome.content) {
        res.write(sse(streamChunk({ id, model: body.model, delta: { content: outcome.content } })));
      } else if (outcome.content.startsWith(emitted) && outcome.content.length > emitted.length) {
        // Flush whatever landed between the backend's last delta and settle.
        res.write(sse(streamChunk({ id, model: body.model, delta: { content: outcome.content.slice(emitted.length) } })));
      }
      res.write(sse(streamChunk({ id, model: body.model, delta: {}, finishReason: outcome.finishReason ?? "stop", usage: outcome.usage })));
      res.write(SSE_DONE);
      res.end();
      if (cacheable) deps.cache.set(key, body.model, { content: outcome.content, usage: outcome.usage });
      repos.finishRequest(deps.db, requestId, {
        status: "ok",
        capabilityId,
        clientId: outcome.clientId,
        attempts: outcome.attempts,
        latencyMs: Date.now() - startedAt,
        usage: outcome.usage,
      });
      return;
    }

    // Errors mid-stream: emit an OpenAI-shaped error frame, then close cleanly.
    res.write(sse(buildErrorBody(outcome.status, outcome.message)));
    res.write(SSE_DONE);
    res.end();
    repos.finishRequest(deps.db, requestId, {
      status: "error",
      capabilityId,
      attempts: outcome.attempts,
      latencyMs: Date.now() - startedAt,
      errorCode: outcome.code,
      errorMessage: outcome.message,
    });
    return;
  }

  /* -------------------------------------------------------- non-streaming */
  const outcome = await runWithFailover(deps, {
    requestId,
    capabilityId,
    subModel,
    messages: body.messages,
    stream: false,
    temperature: body.temperature,
    maxTokens: body.max_tokens,
    stop,
    callerIp,
  });

  if (outcome.ok) {
    if (cacheable) deps.cache.set(key, body.model, { content: outcome.content, usage: outcome.usage });
    repos.finishRequest(deps.db, requestId, {
      status: "ok",
      capabilityId,
      clientId: outcome.clientId,
      attempts: outcome.attempts,
      latencyMs: Date.now() - startedAt,
      usage: outcome.usage,
    });
    res.setHeader("x-aigw-cache", "miss");
    res.setHeader("x-aigw-request-id", requestId);
    res.setHeader("x-aigw-client", outcome.clientId);
    res.json(
      nonStreamingBody({
        id,
        model: body.model,
        content: outcome.content,
        usage: outcome.usage,
        finishReason: outcome.finishReason,
      }),
    );
    return;
  }

  repos.finishRequest(deps.db, requestId, {
    status: "error",
    capabilityId,
    attempts: outcome.attempts,
    latencyMs: Date.now() - startedAt,
    errorCode: outcome.code,
    errorMessage: outcome.message,
  });
  res.status(outcome.status).setHeader("x-aigw-request-id", requestId);
  res.json(buildErrorBody(outcome.status, outcome.message));
}

function openSseHeaders(res: Response, requestId: string, cacheState: string): void {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("x-aigw-request-id", requestId);
  res.setHeader("x-aigw-cache", cacheState);
  res.flushHeaders?.();
}
