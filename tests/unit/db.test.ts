import { describe, expect, it, beforeEach } from "vitest";
import { openDatabase, migrate, getMeta } from "../../packages/server/src/db/index.ts";
import * as repos from "../../packages/server/src/db/repos.ts";
import type { Capability, ClientRegisterPayload } from "@aigw/shared";

const caps: Capability[] = [
  { id: "cli/echo", kind: "cli", provider: "echo", displayName: "Echo", available: true, concurrency: 2, models: ["v1"] },
  { id: "web/chatgpt", kind: "browser", provider: "chatgpt", displayName: "ChatGPT", available: false, reason: "no tab", concurrency: 1 },
];

const reg: ClientRegisterPayload = {
  protocolVersion: 1,
  agentId: "agent-1",
  name: "box",
  version: "1.0.0",
  platform: "linux",
  capabilities: caps,
  maxConcurrency: 4,
};

describe("schema", () => {
  it("creates tables and records the schema version", () => {
    const db = openDatabase(":memory:");
    expect(getMeta(db, "schemaVersion")).toBe("1");
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
    for (const t of ["clients", "capabilities", "api_keys", "requests", "request_events", "response_cache"]) {
      expect(tables).toContain(t);
    }
  });

  it("is idempotent across repeated migrations", () => {
    const db = openDatabase(":memory:");
    expect(() => {
      migrate(db);
      migrate(db);
    }).not.toThrow();
  });

  it("adds a column declared later without losing rows", () => {
    const db = openDatabase(":memory:");
    repos.upsertClient(db, reg, "127.0.0.1");
    db.exec(`ALTER TABLE clients DROP COLUMN tags`);
    migrate(db);
    const cols = (db.prepare(`PRAGMA table_info("clients")`).all() as Array<{ name: string }>).map((r) => r.name);
    expect(cols).toContain("tags");
    expect(repos.listClients(db)).toHaveLength(1);
  });
});

describe("client + capability repos", () => {
  let db: ReturnType<typeof openDatabase>;
  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  it("upserts a client and marks it online", () => {
    repos.upsertClient(db, reg, "10.0.0.1");
    const [row] = repos.listClients(db);
    expect(row.id).toBe("agent-1");
    expect(row.status).toBe("online");
    expect(row.remote_addr).toBe("10.0.0.1");
  });

  it("reconnect reuses the row and resets counters", () => {
    repos.upsertClient(db, reg, "10.0.0.1");
    repos.touchHeartbeat(db, "agent-1", 3);
    repos.markClientOffline(db, "agent-1");
    repos.upsertClient(db, reg, "10.0.0.2");
    const rows = repos.listClients(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("online");
    expect(rows[0].active_jobs).toBe(0);
  });

  it("stores capabilities and only lists available ones for online clients", () => {
    repos.upsertClient(db, reg, "x");
    repos.replaceCapabilities(db, "agent-1", caps);
    expect(repos.listAvailableCapabilities(db).map((c) => c.capability_id)).toEqual(["cli/echo"]);
    repos.markClientOffline(db, "agent-1");
    expect(repos.listAvailableCapabilities(db)).toHaveLength(0);
  });

  it("drops capabilities that disappeared from the client", () => {
    repos.upsertClient(db, reg, "x");
    repos.replaceCapabilities(db, "agent-1", caps);
    repos.replaceCapabilities(db, "agent-1", [caps[0]]);
    const all = db.prepare(`SELECT capability_id FROM capabilities WHERE client_id='agent-1'`).all();
    expect(all).toEqual([{ capability_id: "cli/echo" }]);
  });

  it("counts heartbeat misses", () => {
    repos.upsertClient(db, reg, "x");
    expect(repos.bumpHeartbeatMiss(db, "agent-1")).toBe(1);
    expect(repos.bumpHeartbeatMiss(db, "agent-1")).toBe(2);
    repos.touchHeartbeat(db, "agent-1", 0);
    expect(repos.bumpHeartbeatMiss(db, "agent-1")).toBe(1);
  });
});

describe("api keys", () => {
  it("validates only active seeded keys", () => {
    const db = openDatabase(":memory:");
    repos.seedApiKey(db, "sk-test", "bootstrap");
    expect(repos.isValidApiKey(db, "sk-test")).toBe(true);
    expect(repos.isValidApiKey(db, "sk-nope")).toBe(false);
    db.prepare(`UPDATE api_keys SET active = 0 WHERE key = 'sk-test'`).run();
    expect(repos.isValidApiKey(db, "sk-test")).toBe(false);
  });
});

describe("request accounting", () => {
  it("records lifecycle, events and usage rollups", () => {
    const db = openDatabase(":memory:");
    repos.createRequest(db, { id: "r1", model: "cli/echo", stream: true, apiKey: "sk" });
    repos.addRequestEvent(db, "r1", "dispatch", { clientId: "agent-1" });
    repos.finishRequest(db, "r1", {
      status: "ok",
      capabilityId: "cli/echo",
      clientId: "agent-1",
      attempts: 1,
      latencyMs: 120,
      usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 },
    });
    const [row] = repos.recentRequests(db);
    expect(row.status).toBe("ok");
    expect(row.total_tokens).toBe(12);
    expect(row.client_id).toBe("agent-1");
    const summary = repos.usageSummary(db) as { totals: Record<string, number> };
    expect(summary.totals.requests).toBe(1);
    expect(summary.totals.ok).toBe(1);
    expect(summary.totals.tokens).toBe(12);
    const events = db.prepare(`SELECT kind FROM request_events WHERE request_id='r1'`).all();
    expect(events).toEqual([{ kind: "dispatch" }]);
  });
});
