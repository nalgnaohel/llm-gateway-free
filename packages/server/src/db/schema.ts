/** Declarative schema. Tables are created from this object, and any column added
 *  here later is auto-applied with ALTER TABLE ADD COLUMN on the next boot. */

export type ColumnDef = string;
export type TableDef = { columns: Record<string, ColumnDef>; indexes?: string[][]; unique?: string[][] };

export const PRAGMAS = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA synchronous = NORMAL",
  "PRAGMA foreign_keys = ON",
  "PRAGMA busy_timeout = 5000",
  "PRAGMA cache_size = -32000",
] as const;

export const SCHEMA_VERSION = 1;

export const TABLES: Record<string, TableDef> = {
  meta: {
    columns: { key: "TEXT PRIMARY KEY", value: "TEXT" },
  },

  clients: {
    columns: {
      id: "TEXT PRIMARY KEY", // agentId (stable per machine)
      name: "TEXT NOT NULL",
      version: "TEXT",
      platform: "TEXT",
      status: "TEXT NOT NULL DEFAULT 'offline'", // online | offline
      max_concurrency: "INTEGER NOT NULL DEFAULT 1",
      active_jobs: "INTEGER NOT NULL DEFAULT 0",
      tags: "TEXT NOT NULL DEFAULT '[]'",
      remote_addr: "TEXT",
      connected_at: "INTEGER",
      last_seen_at: "INTEGER",
      last_heartbeat_at: "INTEGER",
      heartbeat_misses: "INTEGER NOT NULL DEFAULT 0",
      total_jobs: "INTEGER NOT NULL DEFAULT 0",
      failed_jobs: "INTEGER NOT NULL DEFAULT 0",
      data: "TEXT NOT NULL DEFAULT '{}'",
    },
    indexes: [["status"], ["last_seen_at"]],
  },

  capabilities: {
    columns: {
      id: "INTEGER PRIMARY KEY AUTOINCREMENT",
      client_id: "TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE",
      capability_id: "TEXT NOT NULL",
      kind: "TEXT NOT NULL",
      provider: "TEXT NOT NULL",
      display_name: "TEXT NOT NULL",
      available: "INTEGER NOT NULL DEFAULT 0",
      reason: "TEXT",
      concurrency: "INTEGER NOT NULL DEFAULT 1",
      models: "TEXT NOT NULL DEFAULT '[]'",
      updated_at: "INTEGER NOT NULL DEFAULT 0",
    },
    unique: [["client_id", "capability_id"]],
    indexes: [["capability_id"], ["available"]],
  },

  api_keys: {
    columns: {
      id: "INTEGER PRIMARY KEY AUTOINCREMENT",
      key: "TEXT NOT NULL UNIQUE",
      label: "TEXT",
      active: "INTEGER NOT NULL DEFAULT 1",
      created_at: "INTEGER NOT NULL DEFAULT 0",
      last_used_at: "INTEGER",
    },
  },

  requests: {
    columns: {
      id: "TEXT PRIMARY KEY",
      created_at: "INTEGER NOT NULL",
      finished_at: "INTEGER",
      model: "TEXT NOT NULL",
      capability_id: "TEXT",
      client_id: "TEXT",
      status: "TEXT NOT NULL", // pending | streaming | ok | error | cancelled
      stream: "INTEGER NOT NULL DEFAULT 0",
      cache_hit: "INTEGER NOT NULL DEFAULT 0",
      attempts: "INTEGER NOT NULL DEFAULT 0",
      latency_ms: "INTEGER",
      prompt_tokens: "INTEGER NOT NULL DEFAULT 0",
      completion_tokens: "INTEGER NOT NULL DEFAULT 0",
      total_tokens: "INTEGER NOT NULL DEFAULT 0",
      api_key: "TEXT",
      error_code: "TEXT",
      error_message: "TEXT",
    },
    indexes: [["created_at"], ["model"], ["client_id"], ["status"]],
  },

  request_events: {
    columns: {
      id: "INTEGER PRIMARY KEY AUTOINCREMENT",
      request_id: "TEXT NOT NULL",
      at: "INTEGER NOT NULL",
      kind: "TEXT NOT NULL",
      detail: "TEXT",
    },
    indexes: [["request_id"]],
  },

  response_cache: {
    columns: {
      key: "TEXT PRIMARY KEY",
      model: "TEXT NOT NULL",
      content: "TEXT NOT NULL",
      usage: "TEXT NOT NULL DEFAULT '{}'",
      created_at: "INTEGER NOT NULL",
      expires_at: "INTEGER NOT NULL",
      hits: "INTEGER NOT NULL DEFAULT 0",
    },
    indexes: [["expires_at"]],
  },
};

export function buildCreateTableSql(name: string, def: TableDef): string[] {
  const cols = Object.entries(def.columns).map(([c, t]) => `  "${c}" ${t}`);
  for (const u of def.unique ?? []) cols.push(`  UNIQUE(${u.map((c) => `"${c}"`).join(", ")})`);
  const stmts = [`CREATE TABLE IF NOT EXISTS "${name}" (\n${cols.join(",\n")}\n)`];
  for (const idx of def.indexes ?? []) {
    stmts.push(
      `CREATE INDEX IF NOT EXISTS "idx_${name}_${idx.join("_")}" ON "${name}" (${idx.map((c) => `"${c}"`).join(", ")})`,
    );
  }
  return stmts;
}
