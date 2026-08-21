import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { buildErrorBody, estimateTokens, type JobUsage } from "@aigw/shared";
import type { AgentHub } from "../hub/hub.ts";
import { GatewayError, type JobEvent } from "../hub/types.ts";
import * as repos from "../db/repos.ts";
import type { Db } from "../db/index.ts";
import type { ServerConfig } from "../config.ts";

export type TestPromptDeps = { db: Db; hub: AgentHub; cfg: ServerConfig };

/**
 * Dashboard-only prompt tester: dispatches straight to one named client
 * instead of letting the routing strategy pick, and streams raw SSE frames
 * (not the OpenAI wire shape — this never faces an OpenAI-compatible caller).
 */
export async function handleTestPrompt(deps: TestPromptDeps, req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const clientId = String(body.clientId ?? "").trim();
  const capabilityId = String(body.capabilityId ?? "").trim();
  const prompt = String(body.prompt ?? "");
  const subModel = typeof body.subModel === "string" && body.subModel ? body.subModel : undefined;
  const temperature = typeof body.temperature === "number" ? body.temperature : undefined;
  const maxTokens = typeof body.maxTokens === "number" ? body.maxTokens : undefined;

  if (!clientId || !capabilityId || !prompt.trim()) {
    res.status(400).json(buildErrorBody(400, "clientId, capabilityId và prompt là bắt buộc"));
    return;
  }

  const requestId = randomUUID();
  const startedAt = Date.now();

  let dispatched: { jobId: string; clientId: string; emitter: EventEmitter };
  try {
    dispatched = deps.hub.dispatch({
      requestId,
      capabilityId,
      model: subModel,
      messages: [{ role: "user", content: prompt }],
      stream: true,
      temperature,
      maxTokens,
      timeoutMs: deps.cfg.jobTimeoutMs,
      targetClientId: clientId,
    });
  } catch (err) {
    const ge = err instanceof GatewayError ? err : new GatewayError(500, "internal_error", String(err));
    res.status(ge.status).json(buildErrorBody(ge.status, ge.message));
    return;
  }

  repos.createRequest(deps.db, {
    id: requestId,
    model: subModel ? `${capabilityId}:${subModel}` : capabilityId,
    stream: true,
    apiKey: null,
  });
  repos.addRequestEvent(deps.db, requestId, "dispatch", {
    clientId: dispatched.clientId,
    jobId: dispatched.jobId,
    source: "dashboard-test-prompt",
  });

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (obj: Record<string, unknown>) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  send({ type: "start", clientId: dispatched.clientId, jobId: dispatched.jobId });

  let buffer = "";
  let settled = false;

  dispatched.emitter.on("event", (ev: JobEvent) => {
    if (settled) return;

    if (ev.type === "accepted") {
      send({ type: "accepted" });
      return;
    }

    if (ev.type === "chunk") {
      buffer += ev.delta;
      send({ type: "chunk", delta: ev.delta });
      return;
    }

    if (ev.type === "done") {
      settled = true;
      const content = ev.content || buffer;
      const promptTokens = estimateTokens(prompt);
      const completionTokens = ev.usage?.completionTokens ?? estimateTokens(content);
      const usage: JobUsage = ev.usage ?? { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
      repos.finishRequest(deps.db, requestId, {
        status: "ok",
        capabilityId,
        clientId: dispatched.clientId,
        attempts: 1,
        latencyMs: Date.now() - startedAt,
        usage,
      });
      send({
        type: "done",
        content,
        usage,
        finishReason: ev.finishReason,
        latencyMs: Date.now() - startedAt,
        clientId: dispatched.clientId,
      });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    if (ev.type === "error") {
      settled = true;
      repos.finishRequest(deps.db, requestId, {
        status: "error",
        capabilityId,
        clientId: dispatched.clientId,
        attempts: 1,
        latencyMs: Date.now() - startedAt,
        errorCode: ev.code,
        errorMessage: ev.message,
      });
      send({ type: "error", code: ev.code, message: ev.message, retryable: ev.retryable });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
  });

  res.on("close", () => {
    if (settled) return;
    settled = true;
    deps.hub.cancel(dispatched.jobId, "dashboard test prompt disconnected");
  });
}
