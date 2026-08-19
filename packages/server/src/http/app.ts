import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { buildErrorBody } from "@aigw/shared";
import type { Db } from "../db/index.ts";
import * as repos from "../db/repos.ts";
import type { AgentHub } from "../hub/hub.ts";
import type { ServerConfig } from "../config.ts";
import { ResponseCache, TtlValue } from "../cache.ts";
import { handleChatCompletions } from "./chat.ts";
import { logger } from "../log.ts";

const log = logger("http");

export type AppDeps = { db: Db; hub: AgentHub; cfg: ServerConfig; cache: ResponseCache };

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "25mb" }));

  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, x-api-key");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  const modelsCache = new TtlValue<ReturnType<typeof buildModels>>(deps.cfg.modelsCacheTtlMs);
  deps.hub.events.on("clients-changed", () => modelsCache.invalidate());

  function buildModels() {
    const caps = deps.hub.capabilities();
    const created = Math.floor(Date.now() / 1000);
    const data: Array<Record<string, unknown>> = [];
    for (const cap of caps) {
      data.push({
        id: cap.id,
        object: "model",
        created,
        owned_by: cap.kind === "browser" ? "browser-agent" : "cli-agent",
        aigw: { kind: cap.kind, provider: cap.provider, displayName: cap.displayName, clients: cap.clients, freeSlots: cap.slots },
      });
      for (const sub of cap.models) {
        data.push({
          id: `${cap.id}:${sub}`,
          object: "model",
          created,
          owned_by: cap.kind === "browser" ? "browser-agent" : "cli-agent",
          aigw: { kind: cap.kind, provider: cap.provider, displayName: `${cap.displayName} (${sub})`, clients: cap.clients },
        });
      }
    }
    return { object: "list" as const, data };
  }

  /* ------------------------------------------------------------- auth */

  const requireApiKey = (req: Request, res: Response, next: NextFunction) => {
    if (!deps.cfg.requireApiKey) return next();
    const header = req.headers.authorization ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const key = bearer || String(req.headers["x-api-key"] ?? "");
    if (!key) {
      res.status(401).json(buildErrorBody(401, "missing API key"));
      return;
    }
    if (!repos.isValidApiKey(deps.db, key)) {
      res.status(401).json(buildErrorBody(401, "invalid API key"));
      return;
    }
    res.locals.apiKey = key;
    next();
  };

  /* ------------------------------------------------------------ health */

  app.get(["/health", "/healthz", "/api/health"], (_req, res) => {
    const clients = deps.hub.listClients();
    res.json({
      status: "ok",
      uptimeSec: Math.floor(process.uptime()),
      clients: clients.length,
      onlineCapabilities: deps.hub.capabilities().length,
      activeJobs: clients.reduce((n, c) => n + c.inflight.size, 0),
      cache: deps.cache.stats(),
      time: Date.now(),
    });
  });

  /* --------------------------------------------------------- OpenAI API */

  app.get(["/v1/models", "/v1/models/"], requireApiKey, (_req, res) => {
    res.json(modelsCache.get(buildModels));
  });

  app.get("/v1/models/:id", requireApiKey, (req, res) => {
    const found = modelsCache.get(buildModels).data.find((m) => m.id === req.params.id);
    if (!found) {
      res.status(404).json(buildErrorBody(404, `model "${req.params.id}" not found`, "model"));
      return;
    }
    res.json(found);
  });

  app.post("/v1/chat/completions", requireApiKey, (req, res) => {
    handleChatCompletions({ db: deps.db, hub: deps.hub, cache: deps.cache, cfg: deps.cfg }, req, res).catch((err) => {
      log.error("unhandled chat error", String(err?.stack ?? err));
      if (!res.headersSent) res.status(500).json(buildErrorBody(500, "internal gateway error"));
      else res.end();
    });
  });

  /* ------------------------------------------------------------- admin */

  app.get("/api/clients", (_req, res) => {
    res.json({
      live: deps.hub.listClients().map((c) => ({
        clientId: c.clientId,
        name: c.name,
        version: c.version,
        platform: c.platform,
        remoteAddr: c.remoteAddr,
        connectedAt: c.connectedAt,
        lastHeartbeatAt: c.lastHeartbeatAt,
        maxConcurrency: c.maxConcurrency,
        activeJobs: c.inflight.size,
        capabilities: [...c.capabilities.values()],
      })),
      persisted: repos.listClients(deps.db),
    });
  });

  app.get("/api/capabilities", (_req, res) => res.json({ capabilities: deps.hub.capabilities() }));
  app.get("/api/requests", (req, res) =>
    res.json({ requests: repos.recentRequests(deps.db, Number(req.query.limit ?? 50)) }),
  );
  app.get("/api/usage", (_req, res) => res.json(repos.usageSummary(deps.db)));
  app.get("/api/cache", (_req, res) => res.json(deps.cache.stats()));
  app.delete("/api/cache", (_req, res) => {
    deps.db.prepare(`DELETE FROM response_cache`).run();
    res.json({ ok: true });
  });

  app.use((req, res) => {
    res.status(404).json(buildErrorBody(404, `no route for ${req.method} ${req.path}`));
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    log.error("express error", String(err.stack ?? err));
    if (!res.headersSent) res.status(500).json(buildErrorBody(500, err.message || "internal error"));
  });

  return app;
}
