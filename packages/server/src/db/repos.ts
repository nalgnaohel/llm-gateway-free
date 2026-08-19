import type { Db } from "./index.ts";
import type { Capability, ClientRegisterPayload, JobUsage } from "@aigw/shared";

const now = () => Date.now();

/* ------------------------------------------------------------------ clients */

export function upsertClient(db: Db, p: ClientRegisterPayload, remoteAddr: string): void {
  db.prepare(
    `INSERT INTO clients (id, name, version, platform, status, max_concurrency, active_jobs, tags,
                          remote_addr, connected_at, last_seen_at, last_heartbeat_at, heartbeat_misses)
     VALUES (@id, @name, @version, @platform, 'online', @max_concurrency, 0, @tags,
             @remote_addr, @ts, @ts, @ts, 0)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, version = excluded.version, platform = excluded.platform,
       status = 'online', max_concurrency = excluded.max_concurrency, active_jobs = 0,
       tags = excluded.tags, remote_addr = excluded.remote_addr,
       connected_at = excluded.connected_at, last_seen_at = excluded.last_seen_at,
       last_heartbeat_at = excluded.last_heartbeat_at, heartbeat_misses = 0`,
  ).run({
    id: p.agentId,
    name: p.name,
    version: p.version,
    platform: p.platform,
    max_concurrency: p.maxConcurrency,
    tags: JSON.stringify(p.tags ?? []),
    remote_addr: remoteAddr,
    ts: now(),
  });
}

export function markClientOffline(db: Db, clientId: string): void {
  db.transaction(() => {
    db.prepare(`UPDATE clients SET status = 'offline', active_jobs = 0, last_seen_at = ? WHERE id = ?`).run(
      now(),
      clientId,
    );
    db.prepare(`UPDATE capabilities SET available = 0, reason = 'client offline', updated_at = ? WHERE client_id = ?`).run(
      now(),
      clientId,
    );
  })();
}

export function touchHeartbeat(db: Db, clientId: string, activeJobs: number): void {
  db.prepare(
    `UPDATE clients SET last_heartbeat_at = ?, last_seen_at = ?, heartbeat_misses = 0, active_jobs = ? WHERE id = ?`,
  ).run(now(), now(), activeJobs, clientId);
}

export function bumpHeartbeatMiss(db: Db, clientId: string): number {
  db.prepare(`UPDATE clients SET heartbeat_misses = heartbeat_misses + 1 WHERE id = ?`).run(clientId);
  const row = db.prepare(`SELECT heartbeat_misses AS m FROM clients WHERE id = ?`).get(clientId) as
    | { m: number }
    | undefined;
  return row?.m ?? 0;
}

export function recordJobOutcome(db: Db, clientId: string, ok: boolean): void {
  db.prepare(`UPDATE clients SET total_jobs = total_jobs + 1, failed_jobs = failed_jobs + ? WHERE id = ?`).run(
    ok ? 0 : 1,
    clientId,
  );
}

export function listClients(db: Db): Array<Record<string, unknown>> {
  return db.prepare(`SELECT * FROM clients ORDER BY last_seen_at DESC`).all() as Array<Record<string, unknown>>;
}

/* ------------------------------------------------------------- capabilities */

export function replaceCapabilities(db: Db, clientId: string, caps: Capability[]): void {
  db.transaction(() => {
    const keep = caps.map((c) => c.id);
    const del = db.prepare(
      `DELETE FROM capabilities WHERE client_id = ? AND capability_id NOT IN (${keep.map(() => "?").join(",") || "''"})`,
    );
    del.run(clientId, ...keep);
    const up = db.prepare(
      `INSERT INTO capabilities (client_id, capability_id, kind, provider, display_name, available, reason, concurrency, models, updated_at)
       VALUES (@client_id, @capability_id, @kind, @provider, @display_name, @available, @reason, @concurrency, @models, @updated_at)
       ON CONFLICT(client_id, capability_id) DO UPDATE SET
         kind = excluded.kind, provider = excluded.provider, display_name = excluded.display_name,
         available = excluded.available, reason = excluded.reason, concurrency = excluded.concurrency,
         models = excluded.models, updated_at = excluded.updated_at`,
    );
    for (const c of caps) {
      up.run({
        client_id: clientId,
        capability_id: c.id,
        kind: c.kind,
        provider: c.provider,
        display_name: c.displayName,
        available: c.available ? 1 : 0,
        reason: c.reason ?? null,
        concurrency: c.concurrency,
        models: JSON.stringify(c.models ?? []),
        updated_at: now(),
      });
    }
  })();
}

export type CapabilityRow = {
  client_id: string;
  capability_id: string;
  kind: string;
  provider: string;
  display_name: string;
  available: number;
  reason: string | null;
  concurrency: number;
  models: string;
};

export function listAvailableCapabilities(db: Db): CapabilityRow[] {
  return db
    .prepare(
      `SELECT c.* FROM capabilities c
       JOIN clients cl ON cl.id = c.client_id
       WHERE c.available = 1 AND cl.status = 'online'
       ORDER BY c.capability_id`,
    )
    .all() as CapabilityRow[];
}

/* ---------------------------------------------------------------- api keys */

export function seedApiKey(db: Db, key: string, label: string): void {
  if (!key) return;
  db.prepare(`INSERT INTO api_keys(key,label,active,created_at) VALUES(?,?,1,?) ON CONFLICT(key) DO NOTHING`).run(
    key,
    label,
    now(),
  );
}

export function isValidApiKey(db: Db, key: string): boolean {
  const row = db.prepare(`SELECT active FROM api_keys WHERE key = ?`).get(key) as { active: number } | undefined;
  if (!row || !row.active) return false;
  db.prepare(`UPDATE api_keys SET last_used_at = ? WHERE key = ?`).run(now(), key);
  return true;
}

/* ---------------------------------------------------------------- requests */

export function createRequest(
  db: Db,
  r: { id: string; model: string; stream: boolean; apiKey?: string | null },
): void {
  db.prepare(
    `INSERT INTO requests (id, created_at, model, status, stream, api_key) VALUES (?,?,?,'pending',?,?)`,
  ).run(r.id, now(), r.model, r.stream ? 1 : 0, r.apiKey ?? null);
}

export function addRequestEvent(db: Db, requestId: string, kind: string, detail?: unknown): void {
  db.prepare(`INSERT INTO request_events (request_id, at, kind, detail) VALUES (?,?,?,?)`).run(
    requestId,
    now(),
    kind,
    detail === undefined ? null : typeof detail === "string" ? detail : JSON.stringify(detail),
  );
}

export function finishRequest(
  db: Db,
  id: string,
  patch: {
    status: string;
    capabilityId?: string | null;
    clientId?: string | null;
    attempts?: number;
    cacheHit?: boolean;
    latencyMs?: number;
    usage?: JobUsage;
    errorCode?: string | null;
    errorMessage?: string | null;
  },
): void {
  db.prepare(
    `UPDATE requests SET finished_at = @finished_at, status = @status, capability_id = @capability_id,
       client_id = @client_id, attempts = @attempts, cache_hit = @cache_hit, latency_ms = @latency_ms,
       prompt_tokens = @prompt_tokens, completion_tokens = @completion_tokens, total_tokens = @total_tokens,
       error_code = @error_code, error_message = @error_message
     WHERE id = @id`,
  ).run({
    id,
    finished_at: now(),
    status: patch.status,
    capability_id: patch.capabilityId ?? null,
    client_id: patch.clientId ?? null,
    attempts: patch.attempts ?? 0,
    cache_hit: patch.cacheHit ? 1 : 0,
    latency_ms: patch.latencyMs ?? null,
    prompt_tokens: patch.usage?.promptTokens ?? 0,
    completion_tokens: patch.usage?.completionTokens ?? 0,
    total_tokens: patch.usage?.totalTokens ?? 0,
    error_code: patch.errorCode ?? null,
    error_message: patch.errorMessage ?? null,
  });
}

export function recentRequests(db: Db, limit = 50): Array<Record<string, unknown>> {
  return db.prepare(`SELECT * FROM requests ORDER BY created_at DESC LIMIT ?`).all(limit) as Array<
    Record<string, unknown>
  >;
}

export function usageSummary(db: Db): Record<string, unknown> {
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS requests,
              SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errors,
              SUM(cache_hit) AS cache_hits,
              SUM(total_tokens) AS tokens,
              AVG(latency_ms) AS avg_latency_ms
       FROM requests`,
    )
    .get() as Record<string, unknown>;
  const byModel = db
    .prepare(`SELECT model, COUNT(*) AS n, SUM(total_tokens) AS tokens FROM requests GROUP BY model ORDER BY n DESC`)
    .all();
  return { totals, byModel };
}
