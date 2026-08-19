import http from "node:http";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db/index.ts";
import * as repos from "./db/repos.ts";
import { ResponseCache } from "./cache.ts";
import { AgentHub } from "./hub/hub.ts";
import { createApp } from "./http/app.ts";
import { logger, setLogLevel } from "./log.ts";

export type StartedServer = {
  url: string;
  port: number;
  hub: AgentHub;
  close(): Promise<void>;
};

export async function startServer(env: NodeJS.ProcessEnv = process.env): Promise<StartedServer> {
  const cfg = loadConfig(env);
  setLogLevel(cfg.logLevel);
  const log = logger("main");

  const db = openDatabase(cfg.dbPath);
  // A restart means every previously-known client is gone until it reconnects.
  db.prepare(`UPDATE clients SET status='offline', active_jobs=0`).run();
  db.prepare(`UPDATE capabilities SET available=0, reason='gateway restarted'`).run();
  if (cfg.bootstrapApiKey) repos.seedApiKey(db, cfg.bootstrapApiKey, "bootstrap");

  const cache = new ResponseCache(db, {
    enabled: cfg.cacheEnabled,
    ttlMs: cfg.cacheTtlMs,
    maxEntries: cfg.cacheMaxEntries,
  });
  const pruneTimer = setInterval(() => cache.prune(), 60_000);
  pruneTimer.unref?.();

  const hub = new AgentHub(db, cfg);
  const app = createApp({ db, hub, cfg, cache });
  const server = http.createServer(app);
  hub.attach(server);

  await new Promise<void>((resolve) => server.listen(cfg.port, cfg.host, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : cfg.port;
  const url = `http://${cfg.host === "0.0.0.0" ? "127.0.0.1" : cfg.host}:${port}`;

  log.info(`gateway listening on ${url}`);
  log.info(`  OpenAI API   POST ${url}/v1/chat/completions`);
  log.info(`  agent socket ws://…:${port}/agent  (token ${cfg.agentToken ? "required" : "disabled"})`);
  log.info(`  sqlite       ${cfg.dbPath}`);

  return {
    url,
    port,
    hub,
    async close() {
      clearInterval(pruneTimer);
      await hub.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}

import { fileURLToPath } from "node:url";
import path from "node:path";

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry && entry === fileURLToPath(import.meta.url)) {
  startServer().then((s) => {
    const shutdown = () => {
      s.close().finally(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}
