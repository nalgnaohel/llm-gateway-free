import os from "node:os";
import WebSocket from "ws";
import {
  decode,
  encode,
  PROTOCOL_VERSION,
  type Capability,
  type ClientToServer,
  type JobRequestPayload,
  type ServerToClient,
} from "@aigw/shared";
import type { ClientConfig } from "./config.ts";
import { BrowserExecutor } from "./browser/executor.ts";
import { WEB_PROVIDERS } from "./browser/providers.ts";
import { CliExecutor } from "./cli/executor.ts";
import { logger } from "./log.ts";

const log = logger("agent");

type RunningJob = { controller: AbortController };

export class ClientAgent {
  private readonly cfg: ClientConfig;
  private readonly browser?: BrowserExecutor;
  private readonly cli?: CliExecutor;

  private ws?: WebSocket;
  private reconnectAttempt = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private scanTimer?: NodeJS.Timeout;
  private stopped = false;
  private registered = false;

  private capabilities: Capability[] = [];
  private readonly jobs = new Map<string, RunningJob>();

  /** Resolves the first time the server acknowledges registration. */
  private readyResolvers: Array<() => void> = [];

  constructor(cfg: ClientConfig) {
    this.cfg = cfg;
    if (cfg.browserEnabled) {
      this.browser = new BrowserExecutor({
        cdpUrl: cfg.cdpUrl,
        allowProviders: cfg.browserProviders,
        autoOpenTab: cfg.browserAutoOpenTab,
      });
    }
    if (cfg.cliEnabled) {
      this.cli = new CliExecutor({ cwd: cfg.cliCwd, timeoutMs: cfg.cliTimeoutMs, extra: cfg.cliExtra });
    }
  }

  /* --------------------------------------------------------------- public */

  async start(): Promise<void> {
    this.stopped = false;
    this.capabilities = await this.scanCapabilities();
    this.logCapabilities();
    this.connect();
    this.scanTimer = setInterval(() => {
      void this.rescan();
    }, this.cfg.capabilityScanMs);
    this.scanTimer.unref?.();
  }

  whenReady(timeoutMs = 15_000): Promise<void> {
    if (this.registered) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("client never registered")), timeoutMs);
      timer.unref?.();
      this.readyResolvers.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.scanTimer) clearInterval(this.scanTimer);
    for (const job of this.jobs.values()) job.controller.abort();
    this.jobs.clear();
    try {
      this.ws?.close(1000, "client shutting down");
    } catch {
      /* ignore */
    }
    await this.browser?.dispose();
  }

  currentCapabilities(): Capability[] {
    return this.capabilities;
  }

  /* ---------------------------------------------------------- capabilities */

  private async scanCapabilities(): Promise<Capability[]> {
    const caps: Capability[] = [];

    if (this.browser) {
      const probes = await this.browser.probe().catch((err) => {
        log.warn(`browser probe failed: ${String(err)}`);
        return [];
      });
      for (const p of probes) {
        const provider = WEB_PROVIDERS[p.providerId];
        if (!provider) continue;
        caps.push({
          id: `web/${provider.id}`,
          kind: "browser",
          provider: provider.id,
          displayName: provider.displayName,
          available: p.available,
          reason: p.reason,
          concurrency: this.cfg.browserConcurrency,
          models: provider.models,
        });
      }
    }

    if (this.cli) {
      const probes = await this.cli.probe();
      for (const p of probes) {
        caps.push({
          id: p.adapter.capabilityId,
          kind: "cli",
          provider: p.adapter.id,
          displayName: p.adapter.displayName + (p.version ? ` ${p.version}` : ""),
          available: p.available,
          reason: p.reason,
          concurrency: this.cfg.cliConcurrency,
          models: p.adapter.models,
        });
      }
    }

    return caps;
  }

  private logCapabilities(): void {
    for (const c of this.capabilities) {
      const mark = c.available ? "✓" : "·";
      log.info(`${mark} ${c.id.padEnd(18)} ${c.displayName}${c.available ? "" : ` — ${c.reason ?? "unavailable"}`}`);
    }
  }

  /** Re-probe and push to the server only when something actually changed. */
  private async rescan(): Promise<void> {
    const next = await this.scanCapabilities();
    const before = JSON.stringify(this.capabilities.map((c) => [c.id, c.available, c.reason ?? ""]));
    const after = JSON.stringify(next.map((c) => [c.id, c.available, c.reason ?? ""]));
    this.capabilities = next;
    if (before === after) return;
    log.info("capabilities changed");
    this.logCapabilities();
    this.send({ type: "capabilities", payload: { capabilities: next } });
  }

  /* ------------------------------------------------------------ connection */

  private connect(): void {
    if (this.stopped) return;
    const url = this.cfg.serverUrl;
    log.info(`connecting to ${url} (attempt ${this.reconnectAttempt + 1})`);

    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${this.cfg.agentToken}` } });
    this.ws = ws;

    ws.on("open", () => {
      log.info("socket open — registering");
      this.send({
        type: "register",
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          agentId: this.cfg.agentId,
          name: this.cfg.name,
          version: this.cfg.version,
          platform: `${os.platform()}-${os.arch()}-node${process.versions.node}`,
          capabilities: this.capabilities,
          maxConcurrency: this.cfg.maxConcurrency,
          tags: [],
        },
      });
    });

    ws.on("message", (raw) => {
      let msg: ServerToClient;
      try {
        msg = decode(String(raw)) as ServerToClient;
      } catch {
        log.warn("malformed message from server");
        return;
      }
      void this.handleServerMessage(msg);
    });

    ws.on("close", (code, reason) => {
      const wasRegistered = this.registered;
      this.registered = false;
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      if (wasRegistered) log.warn(`socket closed (${code} ${String(reason)})`);
      this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      log.warn(`socket error: ${String((err as Error).message ?? err)}`);
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    // Exponential backoff with jitter, capped.
    const base = Math.min(this.cfg.reconnectBaseMs * 2 ** this.reconnectAttempt, this.cfg.reconnectMaxMs);
    const delay = Math.round(base * (0.7 + Math.random() * 0.6));
    this.reconnectAttempt += 1;
    log.info(`reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private send(msg: ClientToServer): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encode(msg));
  }

  private async handleServerMessage(msg: ServerToClient): Promise<void> {
    switch (msg.type) {
      case "registered": {
        this.registered = true;
        this.reconnectAttempt = 0;
        log.info(`registered as ${msg.payload.clientId}; heartbeat every ${msg.payload.heartbeatIntervalMs}ms`);
        this.startHeartbeat(msg.payload.heartbeatIntervalMs);
        for (const r of this.readyResolvers.splice(0)) r();
        return;
      }
      case "heartbeat.ack":
        return;
      case "job.request":
        await this.runJob(msg.payload);
        return;
      case "job.cancel": {
        const job = this.jobs.get(msg.payload.jobId);
        if (job) {
          log.info(`job ${msg.payload.jobId} cancelled: ${msg.payload.reason}`);
          job.controller.abort();
        }
        return;
      }
      case "error":
        log.error(`server error ${msg.payload.code}: ${msg.payload.message}`);
        return;
      default:
        return;
    }
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const period = Math.max(1_000, Math.min(intervalMs, this.cfg.heartbeatIntervalMs));
    const beat = () => {
      const mem = process.memoryUsage();
      this.send({
        type: "heartbeat",
        payload: {
          clientTime: Date.now(),
          activeJobs: this.jobs.size,
          cpuLoad: os.loadavg()[0],
          memMb: Math.round(mem.rss / 1024 / 1024),
        },
      });
    };
    beat();
    this.heartbeatTimer = setInterval(beat, period);
    this.heartbeatTimer.unref?.();
  }

  /* ------------------------------------------------------------------ jobs */

  private async runJob(payload: JobRequestPayload): Promise<void> {
    const controller = new AbortController();
    this.jobs.set(payload.jobId, { controller });
    this.send({ type: "job.accepted", payload: { jobId: payload.jobId } });

    let index = 0;
    const onDelta = (delta: string) => {
      if (!delta || !payload.stream) return;
      this.send({ type: "job.chunk", payload: { jobId: payload.jobId, delta, index: index++ } });
    };

    const started = Date.now();
    try {
      const cap = this.capabilities.find((c) => c.id === payload.capabilityId);
      if (!cap) throw new Error(`capability "${payload.capabilityId}" not present on this client`);
      if (!cap.available) throw new Error(`capability "${payload.capabilityId}" is unavailable: ${cap.reason ?? "unknown"}`);

      let content: string;
      if (cap.kind === "browser") {
        if (!this.browser) throw new Error("browser backend disabled on this client");
        const res = await this.browser.run({
          providerId: cap.provider,
          messages: payload.messages,
          timeoutMs: payload.timeoutMs,
          signal: controller.signal,
          onDelta,
        });
        content = res.content;
      } else {
        if (!this.cli) throw new Error("cli backend disabled on this client");
        const res = await this.cli.run({
          capabilityId: cap.id,
          messages: payload.messages,
          model: payload.model,
          stream: payload.stream,
          timeoutMs: payload.timeoutMs,
          signal: controller.signal,
          onDelta,
        });
        content = res.content;
      }

      log.info(`job ${payload.jobId} done via ${cap.id} in ${Date.now() - started}ms (${content.length} chars)`);
      this.send({
        type: "job.done",
        payload: { jobId: payload.jobId, content, finishReason: "stop" },
      });
    } catch (err) {
      const message = String((err as Error)?.message ?? err);
      const cancelled = message === "cancelled" || controller.signal.aborted;
      log.warn(`job ${payload.jobId} failed: ${message}`);
      this.send({
        type: "job.error",
        payload: {
          jobId: payload.jobId,
          code: cancelled ? "CANCELLED" : classifyError(message),
          message,
          // Backend-specific failures are worth retrying elsewhere; a cancel is not.
          retryable: !cancelled,
        },
      });
    } finally {
      this.jobs.delete(payload.jobId);
    }
  }
}

function classifyError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("timed out") || m.includes("timeout")) return "BACKEND_TIMEOUT";
  if (m.includes("not found on path") || m.includes("enoent")) return "BACKEND_MISSING";
  if (m.includes("cannot reach chrome") || m.includes("no open tab")) return "BROWSER_UNAVAILABLE";
  if (m.includes("signed out")) return "NOT_AUTHENTICATED";
  return "BACKEND_ERROR";
}
