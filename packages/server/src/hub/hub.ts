import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Server } from "node:http";
import {
  decode,
  encode,
  PROTOCOL_VERSION,
  type Capability,
  type ClientToServer,
  type ServerToClient,
} from "@aigw/shared";
import type { Db } from "../db/index.ts";
import { getMeta, setMeta } from "../db/index.ts";
import * as repos from "../db/repos.ts";
import { logger } from "../log.ts";
import type { ServerConfig } from "../config.ts";
import { candidatesFor, pickCandidate, aggregateCapabilities, ROUTING_STRATEGIES, type RoutingStrategy } from "./router.ts";
import { GatewayError, type ConnectedClient, type JobEvent, type JobSpec } from "./types.ts";

const log = logger("hub");

type JobHandle = {
  jobId: string;
  requestId: string;
  clientId: string;
  capabilityId: string;
  emitter: EventEmitter;
  acceptedAt?: number;
  ackTimer?: NodeJS.Timeout;
  jobTimer?: NodeJS.Timeout;
  settled: boolean;
};

/**
 * Owns the WebSocket control plane: registration, heartbeat/liveness, capability
 * state and job dispatch. Everything the HTTP layer needs goes through here.
 */
export class AgentHub {
  private readonly clients = new Map<string, ConnectedClient>();
  private readonly jobs = new Map<string, JobHandle>();
  private readonly rrState = new Map<string, number>();
  private readonly waiters = new Set<{ capabilityId: string; resolve: () => void }>();
  private wss?: WebSocketServer;
  private sweepTimer?: NodeJS.Timeout;

  private readonly db: Db;
  private readonly cfg: ServerConfig;
  /** Overrides `cfg.routingStrategy` once set from the admin API; persisted so it survives restarts. */
  private routingStrategy: RoutingStrategy;
  readonly events = new EventEmitter();

  constructor(db: Db, cfg: ServerConfig) {
    this.db = db;
    this.cfg = cfg;
    const persisted = getMeta(db, "routingStrategy");
    this.routingStrategy = (ROUTING_STRATEGIES as string[]).includes(persisted ?? "")
      ? (persisted as RoutingStrategy)
      : (cfg.routingStrategy as RoutingStrategy);
  }

  getRoutingStrategy(): RoutingStrategy {
    return this.routingStrategy;
  }

  setRoutingStrategy(strategy: RoutingStrategy): void {
    this.routingStrategy = strategy;
    setMeta(this.db, "routingStrategy", strategy);
    log.info(`routing strategy changed to ${strategy}`);
  }

  /* ------------------------------------------------------------- lifecycle */

  attach(server: Server): void {
    this.wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/agent") {
        socket.destroy();
        return;
      }
      if (!this.authorizeUpgrade(req, url)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, req));
    });

    this.sweepTimer = setInterval(() => this.sweep(), this.cfg.heartbeatIntervalMs);
    this.sweepTimer.unref?.();
  }

  async close(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const c of this.clients.values()) c.close(1001, "server shutting down");
    this.clients.clear();
    for (const job of this.jobs.values()) this.settle(job, { type: "error", code: "SHUTDOWN", message: "server shutting down", retryable: false });
    await new Promise<void>((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()));
  }

  private authorizeUpgrade(req: IncomingMessage, url: URL): boolean {
    if (!this.cfg.agentToken) return true;
    const header = req.headers.authorization ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
    const query = url.searchParams.get("token") ?? "";
    return bearer === this.cfg.agentToken || query === this.cfg.agentToken;
  }

  /* ------------------------------------------------------------ connection */

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const remoteAddr = (req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
    let client: ConnectedClient | undefined;
    let registerTimer: NodeJS.Timeout | undefined = setTimeout(() => {
      if (!client) ws.close(4001, "register timeout");
    }, 10_000);
    registerTimer.unref?.();

    const send = (msg: ServerToClient) => {
      if (ws.readyState === ws.OPEN) ws.send(encode(msg));
    };

    ws.on("message", (raw) => {
      let msg: ClientToServer;
      try {
        msg = decode(String(raw)) as ClientToServer;
      } catch {
        send({ type: "error", payload: { code: "BAD_MESSAGE", message: "malformed json" } });
        return;
      }

      if (msg.type === "register") {
        if (registerTimer) {
          clearTimeout(registerTimer);
          registerTimer = undefined;
        }
        const p = msg.payload;
        if (p.protocolVersion !== PROTOCOL_VERSION) {
          send({
            type: "error",
            payload: { code: "PROTOCOL_MISMATCH", message: `server speaks v${PROTOCOL_VERSION}, client v${p.protocolVersion}` },
          });
          ws.close(4002, "protocol mismatch");
          return;
        }
        // A reconnect from the same agentId supersedes the previous socket.
        const previous = this.clients.get(p.agentId);
        if (previous) {
          log.warn(`client ${p.agentId} reconnected, dropping stale socket`);
          previous.close(4003, "superseded by new connection");
          this.clients.delete(p.agentId);
        }
        client = {
          clientId: p.agentId,
          name: p.name,
          version: p.version,
          platform: p.platform,
          remoteAddr,
          maxConcurrency: Math.max(1, p.maxConcurrency),
          capabilities: new Map(p.capabilities.map((c) => [c.id, c])),
          inflight: new Set(),
          inflightByCapability: new Map(),
          connectedAt: Date.now(),
          lastHeartbeatAt: Date.now(),
          heartbeatMisses: 0,
          send: (m) => {
            if (ws.readyState === ws.OPEN) ws.send(typeof m === "string" ? m : JSON.stringify(m));
          },
          close: (code, reason) => {
            try {
              ws.close(code, reason);
            } catch {
              /* already closing */
            }
          },
        };
        this.clients.set(client.clientId, client);
        repos.upsertClient(this.db, p, remoteAddr);
        repos.replaceCapabilities(this.db, client.clientId, p.capabilities);
        log.info(`client online: ${client.clientId} (${client.name}) caps=${p.capabilities.length}`);
        send({
          type: "registered",
          payload: {
            clientId: client.clientId,
            heartbeatIntervalMs: this.cfg.heartbeatIntervalMs,
            serverTime: Date.now(),
          },
        });
        this.events.emit("clients-changed");
        this.notifyWaiters();
        return;
      }

      if (!client) {
        send({ type: "error", payload: { code: "NOT_REGISTERED", message: "send register first" } });
        return;
      }
      this.handleClientMessage(client, msg, send);
    });

    const onGone = (why: string) => {
      if (registerTimer) clearTimeout(registerTimer);
      if (!client) return;
      const known = this.clients.get(client.clientId);
      // Only tear down if this socket is still the active one for that agent.
      if (known === client) {
        this.clients.delete(client.clientId);
        repos.markClientOffline(this.db, client.clientId);
        log.info(`client offline: ${client.clientId} (${why})`);
        this.failJobsOfClient(client.clientId, "CLIENT_DISCONNECTED", `client ${client.clientId} disconnected`);
        this.events.emit("clients-changed");
      }
    };

    ws.on("close", () => onGone("close"));
    ws.on("error", (err) => {
      log.warn(`socket error from ${client?.clientId ?? remoteAddr}`, String(err));
      onGone("error");
    });
  }

  private handleClientMessage(
    client: ConnectedClient,
    msg: ClientToServer,
    send: (m: ServerToClient) => void,
  ): void {
    switch (msg.type) {
      case "heartbeat": {
        client.lastHeartbeatAt = Date.now();
        client.heartbeatMisses = 0;
        repos.touchHeartbeat(this.db, client.clientId, client.inflight.size);
        send({ type: "heartbeat.ack", payload: { serverTime: Date.now(), activeJobs: client.inflight.size } });
        return;
      }
      case "capabilities": {
        client.capabilities = new Map(msg.payload.capabilities.map((c: Capability) => [c.id, c]));
        repos.replaceCapabilities(this.db, client.clientId, msg.payload.capabilities);
        log.info(`client ${client.clientId} capabilities updated (${msg.payload.capabilities.length})`);
        this.events.emit("clients-changed");
        this.notifyWaiters();
        return;
      }
      case "job.accepted": {
        const job = this.jobs.get(msg.payload.jobId);
        if (!job) return;
        job.acceptedAt = Date.now();
        if (job.ackTimer) clearTimeout(job.ackTimer);
        job.emitter.emit("event", { type: "accepted", clientId: client.clientId } satisfies JobEvent);
        return;
      }
      case "job.chunk": {
        const job = this.jobs.get(msg.payload.jobId);
        if (!job || job.settled) return;
        job.emitter.emit("event", { type: "chunk", delta: msg.payload.delta, index: msg.payload.index } satisfies JobEvent);
        return;
      }
      case "job.done": {
        const job = this.jobs.get(msg.payload.jobId);
        if (!job) return;
        repos.recordJobOutcome(this.db, client.clientId, true);
        this.settle(job, {
          type: "done",
          content: msg.payload.content,
          usage: msg.payload.usage,
          finishReason: msg.payload.finishReason,
        });
        return;
      }
      case "job.error": {
        const job = this.jobs.get(msg.payload.jobId);
        if (!job) return;
        repos.recordJobOutcome(this.db, client.clientId, false);
        this.settle(job, {
          type: "error",
          code: msg.payload.code,
          message: msg.payload.message,
          retryable: msg.payload.retryable,
        });
        return;
      }
      default:
        return;
    }
  }

  /* ------------------------------------------------------------- liveness */

  /** Evict clients that stopped heart-beating; runs on the heartbeat interval. */
  private sweep(): void {
    const deadline = Date.now() - this.cfg.heartbeatIntervalMs * this.cfg.heartbeatMissTolerance;
    for (const client of [...this.clients.values()]) {
      if (client.lastHeartbeatAt >= deadline) continue;
      const misses = repos.bumpHeartbeatMiss(this.db, client.clientId);
      log.warn(`client ${client.clientId} missed heartbeat (misses=${misses}) — evicting`);
      this.clients.delete(client.clientId);
      repos.markClientOffline(this.db, client.clientId);
      this.failJobsOfClient(client.clientId, "CLIENT_TIMEOUT", "client stopped responding to heartbeat");
      client.close(4004, "heartbeat timeout");
      this.events.emit("clients-changed");
    }
  }

  private failJobsOfClient(clientId: string, code: string, message: string): void {
    for (const job of [...this.jobs.values()]) {
      if (job.clientId !== clientId) continue;
      this.settle(job, { type: "error", code, message, retryable: true });
    }
  }

  /* -------------------------------------------------------------- dispatch */

  listClients(): ConnectedClient[] {
    return [...this.clients.values()];
  }

  capabilities() {
    return aggregateCapabilities(this.clients.values());
  }

  hasCapability(capabilityId: string): boolean {
    for (const c of this.clients.values()) {
      if (c.capabilities.get(capabilityId)?.available) return true;
    }
    return false;
  }

  /** Resolve once a capability becomes available, or after `timeoutMs`. */
  waitForCapability(capabilityId: string, timeoutMs: number): Promise<boolean> {
    if (this.hasCapability(capabilityId)) return Promise.resolve(true);
    if (timeoutMs <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const waiter = {
        capabilityId,
        resolve: () => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          resolve(true);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        resolve(this.hasCapability(capabilityId));
      }, timeoutMs);
      timer.unref?.();
      this.waiters.add(waiter);
    });
  }

  private notifyWaiters(): void {
    for (const waiter of [...this.waiters]) {
      if (this.hasCapability(waiter.capabilityId)) waiter.resolve();
    }
  }

  /**
   * Dispatch one job to the best client for `spec.capabilityId`.
   * Returns an emitter of JobEvents plus the chosen client, or throws
   * GatewayError(503) when nothing can serve it.
   */
  dispatch(spec: JobSpec, exclude: ReadonlySet<string> = new Set()): { jobId: string; clientId: string; emitter: EventEmitter } {
    let candidates = candidatesFor(this.clients.values(), spec.capabilityId, exclude);
    if (spec.targetClientId) candidates = candidates.filter((c) => c.client.clientId === spec.targetClientId);
    const picked = pickCandidate(candidates, this.routingStrategy, this.rrState, spec.capabilityId, spec.callerIp);
    if (!picked) {
      if (spec.targetClientId) {
        const target = this.clients.get(spec.targetClientId);
        const reason = !target
          ? `client "${spec.targetClientId}" is not connected`
          : !target.capabilities.get(spec.capabilityId)?.available
            ? `client "${spec.targetClientId}" does not currently serve "${spec.capabilityId}"`
            : `client "${spec.targetClientId}" has no free slot for "${spec.capabilityId}"`;
        throw new GatewayError(503, "target_client_unavailable", reason);
      }
      const anyClient = [...this.clients.values()].some((c) => c.capabilities.get(spec.capabilityId)?.available);
      throw new GatewayError(
        503,
        anyClient ? "no_free_slot" : "no_active_client",
        anyClient
          ? `all clients serving "${spec.capabilityId}" are at capacity`
          : `no active client provides "${spec.capabilityId}"`,
      );
    }

    const client = picked.client;
    const jobId = randomUUID();
    const emitter = new EventEmitter();
    const job: JobHandle = {
      jobId,
      requestId: spec.requestId,
      clientId: client.clientId,
      capabilityId: spec.capabilityId,
      emitter,
      settled: false,
    };

    client.inflight.add(jobId);
    client.inflightByCapability.set(spec.capabilityId, (client.inflightByCapability.get(spec.capabilityId) ?? 0) + 1);
    this.jobs.set(jobId, job);

    job.ackTimer = setTimeout(() => {
      this.settle(job, {
        type: "error",
        code: "DISPATCH_TIMEOUT",
        message: `client ${client.clientId} did not accept the job in ${this.cfg.dispatchAckTimeoutMs}ms`,
        retryable: true,
      });
    }, this.cfg.dispatchAckTimeoutMs);
    job.ackTimer.unref?.();

    job.jobTimer = setTimeout(() => {
      client.send(encode({ type: "job.cancel", payload: { jobId, reason: "server timeout" } }));
      this.settle(job, {
        type: "error",
        code: "JOB_TIMEOUT",
        message: `job exceeded ${spec.timeoutMs}ms`,
        retryable: false,
      });
    }, spec.timeoutMs + 5_000);
    job.jobTimer.unref?.();

    client.send(
      encode({
        type: "job.request",
        payload: {
          jobId,
          capabilityId: spec.capabilityId,
          model: spec.model,
          messages: spec.messages,
          stream: spec.stream,
          temperature: spec.temperature,
          maxTokens: spec.maxTokens,
          stopSequences: spec.stopSequences,
          timeoutMs: spec.timeoutMs,
          requestId: spec.requestId,
        },
      }),
    );

    log.debug(`dispatched job ${jobId} -> ${client.clientId} (${spec.capabilityId})`);
    return { jobId, clientId: client.clientId, emitter };
  }

  cancel(jobId: string, reason: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    const client = this.clients.get(job.clientId);
    client?.send(encode({ type: "job.cancel", payload: { jobId, reason } }));
    this.settle(job, { type: "error", code: "CANCELLED", message: reason, retryable: false });
  }

  private settle(job: JobHandle, event: JobEvent): void {
    if (job.settled) return;
    job.settled = true;
    if (job.ackTimer) clearTimeout(job.ackTimer);
    if (job.jobTimer) clearTimeout(job.jobTimer);
    this.jobs.delete(job.jobId);
    const client = this.clients.get(job.clientId);
    if (client) {
      client.inflight.delete(job.jobId);
      const n = (client.inflightByCapability.get(job.capabilityId) ?? 1) - 1;
      if (n <= 0) client.inflightByCapability.delete(job.capabilityId);
      else client.inflightByCapability.set(job.capabilityId, n);
    }
    job.emitter.emit("event", event);
    job.emitter.emit("settled", event);
  }
}
