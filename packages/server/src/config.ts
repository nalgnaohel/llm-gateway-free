import path from "node:path";
import os from "node:os";

const num = (v: string | undefined, d: number): number => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};
const bool = (v: string | undefined, d: boolean): boolean =>
  v === undefined ? d : ["1", "true", "yes", "on"].includes(v.toLowerCase());

export type ServerConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const dataDir = env.AIGW_DATA_DIR ?? path.join(os.homedir(), ".ai-gateway");
  return {
    port: num(env.AIGW_PORT, 8787),
    host: env.AIGW_HOST ?? "0.0.0.0",
    dataDir,
    dbPath: env.AIGW_DB_PATH ?? path.join(dataDir, "gateway.sqlite"),

    /** Bearer token client agents must present on the WS upgrade. */
    agentToken: env.AIGW_AGENT_TOKEN ?? "dev-agent-token",
    /** When true, /v1/* requires a key from the api_keys table. */
    requireApiKey: bool(env.AIGW_REQUIRE_API_KEY, false),
    /** Seeded into api_keys on boot when set. */
    bootstrapApiKey: env.AIGW_API_KEY ?? "",

    heartbeatIntervalMs: num(env.AIGW_HEARTBEAT_INTERVAL_MS, 10_000),
    /** Missed heartbeats before a client is evicted as dead. */
    heartbeatMissTolerance: num(env.AIGW_HEARTBEAT_MISS_TOLERANCE, 3),
    /** How long a client has to send job.accepted before we re-route. */
    dispatchAckTimeoutMs: num(env.AIGW_DISPATCH_ACK_TIMEOUT_MS, 10_000),
    /** Overall per-job budget handed to the client. */
    jobTimeoutMs: num(env.AIGW_JOB_TIMEOUT_MS, 300_000),
    /** How many different clients a single request may be retried across. */
    maxRouteAttempts: num(env.AIGW_MAX_ROUTE_ATTEMPTS, 3),
    /** Wait for a capability to come online before 503-ing. */
    queueWaitMs: num(env.AIGW_QUEUE_WAIT_MS, 15_000),

    cacheEnabled: bool(env.AIGW_CACHE_ENABLED, true),
    cacheTtlMs: num(env.AIGW_CACHE_TTL_MS, 10 * 60_000),
    cacheMaxEntries: num(env.AIGW_CACHE_MAX_ENTRIES, 500),
    /** Model-list cache, keeps /v1/models cheap under polling clients. */
    modelsCacheTtlMs: num(env.AIGW_MODELS_CACHE_TTL_MS, 3_000),

    routingStrategy: (env.AIGW_ROUTING_STRATEGY ?? "least-busy") as
      | "least-busy"
      | "round-robin"
      | "fill-first"
      | "ip-hash",
    logLevel: env.AIGW_LOG_LEVEL ?? "info",
  };
}
