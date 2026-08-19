import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

const num = (v: string | undefined, d: number) => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};
const bool = (v: string | undefined, d: boolean) => (v === undefined ? d : ["1", "true", "yes", "on"].includes(v.toLowerCase()));
const list = (v: string | undefined, d: string[]) =>
  v === undefined ? d : v.split(",").map((s) => s.trim()).filter(Boolean);

export type ClientConfig = ReturnType<typeof loadClientConfig>;

/** Stable per-machine agent id, persisted so reconnects reuse the same DB row. */
function resolveAgentId(dataDir: string, explicit?: string): string {
  if (explicit) return explicit;
  const file = path.join(dataDir, "agent-id");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {
    /* first run */
  }
  const id = `agent-${os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, "")}-${crypto.randomBytes(3).toString("hex")}`;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, id);
  return id;
}

export function loadClientConfig(env: NodeJS.ProcessEnv = process.env) {
  const dataDir = env.AIGW_CLIENT_DATA_DIR ?? path.join(os.homedir(), ".ai-gateway-client");
  return {
    serverUrl: env.AIGW_SERVER_URL ?? "ws://127.0.0.1:8787/agent",
    agentToken: env.AIGW_AGENT_TOKEN ?? "dev-agent-token",
    agentId: resolveAgentId(dataDir, env.AIGW_AGENT_ID),
    name: env.AIGW_AGENT_NAME ?? os.hostname(),
    dataDir,

    reconnectBaseMs: num(env.AIGW_RECONNECT_BASE_MS, 1_000),
    reconnectMaxMs: num(env.AIGW_RECONNECT_MAX_MS, 30_000),
    /** Client-side heartbeat cadence; the server sends its own preferred value on register. */
    heartbeatIntervalMs: num(env.AIGW_CLIENT_HEARTBEAT_MS, 10_000),
    /** How often to re-probe browser tabs / CLI binaries. */
    capabilityScanMs: num(env.AIGW_CAPABILITY_SCAN_MS, 15_000),
    maxConcurrency: num(env.AIGW_MAX_CONCURRENCY, 4),

    /* ------------------------------------------------------------ browser */
    browserEnabled: bool(env.AIGW_BROWSER_ENABLED, true),
    /** Chrome/Chromium remote debugging endpoint the agent attaches to. */
    cdpUrl: env.AIGW_CDP_URL ?? "http://127.0.0.1:9222",
    /** Restrict which web providers to expose; empty => all known providers. */
    browserProviders: list(env.AIGW_BROWSER_PROVIDERS, []),
    browserConcurrency: num(env.AIGW_BROWSER_CONCURRENCY, 1),
    /** Open a tab for a provider that has none instead of reporting unavailable. */
    browserAutoOpenTab: bool(env.AIGW_BROWSER_AUTO_OPEN_TAB, false),

    /* ---------------------------------------------------------------- cli */
    cliEnabled: bool(env.AIGW_CLI_ENABLED, true),
    cliConcurrency: num(env.AIGW_CLI_CONCURRENCY, 2),
    cliCwd: env.AIGW_CLI_CWD ?? process.cwd(),
    cliTimeoutMs: num(env.AIGW_CLI_TIMEOUT_MS, 300_000),
    /** Extra adapters for local testing, e.g. the bundled echo CLI. */
    cliExtra: list(env.AIGW_CLI_EXTRA, []),

    logLevel: env.AIGW_LOG_LEVEL ?? "info",
    version: "1.0.0",
  };
}
