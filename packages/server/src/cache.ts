import crypto from "node:crypto";
import type { Db } from "./db/index.ts";
import type { ChatMessage, JobUsage } from "@aigw/shared";
import { logger } from "./log.ts";

const log = logger("cache");

export type CachedResponse = { content: string; usage: JobUsage };

export function cacheKey(input: {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
}): string {
  const canonical = JSON.stringify({
    m: input.model,
    msgs: input.messages.map((x) => [x.role, x.content, x.name ?? ""]),
    t: input.temperature ?? null,
    mt: input.maxTokens ?? null,
    s: input.stop ?? null,
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

type Entry = { value: CachedResponse; expiresAt: number };

/**
 * Two-tier response cache: an in-process LRU in front of a SQLite table so a
 * gateway restart keeps warm entries. Writes go to both tiers; reads promote.
 */
export class ResponseCache {
  private readonly lru = new Map<string, Entry>();
  private hitsMemory = 0;
  private hitsDisk = 0;
  private misses = 0;

  private readonly db: Db;
  private readonly opts: { enabled: boolean; ttlMs: number; maxEntries: number };

  constructor(db: Db, opts: { enabled: boolean; ttlMs: number; maxEntries: number }) {
    this.db = db;
    this.opts = opts;
  }

  get(key: string): CachedResponse | undefined {
    if (!this.opts.enabled) return undefined;
    const now = Date.now();

    const mem = this.lru.get(key);
    if (mem) {
      if (mem.expiresAt > now) {
        // LRU touch: re-insert to move to the tail.
        this.lru.delete(key);
        this.lru.set(key, mem);
        this.hitsMemory += 1;
        return mem.value;
      }
      this.lru.delete(key);
    }

    const row = this.db.prepare(`SELECT content, usage, expires_at FROM response_cache WHERE key = ?`).get(key) as
      | { content: string; usage: string; expires_at: number }
      | undefined;
    if (!row) {
      this.misses += 1;
      return undefined;
    }
    if (row.expires_at <= now) {
      this.db.prepare(`DELETE FROM response_cache WHERE key = ?`).run(key);
      this.misses += 1;
      return undefined;
    }
    const value: CachedResponse = { content: row.content, usage: JSON.parse(row.usage) as JobUsage };
    this.putMemory(key, value, row.expires_at);
    this.db.prepare(`UPDATE response_cache SET hits = hits + 1 WHERE key = ?`).run(key);
    this.hitsDisk += 1;
    return value;
  }

  set(key: string, model: string, value: CachedResponse): void {
    if (!this.opts.enabled || !value.content) return;
    const expiresAt = Date.now() + this.opts.ttlMs;
    this.putMemory(key, value, expiresAt);
    try {
      this.db
        .prepare(
          `INSERT INTO response_cache (key, model, content, usage, created_at, expires_at, hits)
           VALUES (?,?,?,?,?,?,0)
           ON CONFLICT(key) DO UPDATE SET content = excluded.content, usage = excluded.usage,
             created_at = excluded.created_at, expires_at = excluded.expires_at`,
        )
        .run(key, model, value.content, JSON.stringify(value.usage), Date.now(), expiresAt);
    } catch (err) {
      log.warn("disk cache write failed", String(err));
    }
  }

  private putMemory(key: string, value: CachedResponse, expiresAt: number): void {
    this.lru.delete(key);
    this.lru.set(key, { value, expiresAt });
    while (this.lru.size > this.opts.maxEntries) {
      const oldest = this.lru.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.lru.delete(oldest);
    }
  }

  prune(): number {
    const now = Date.now();
    for (const [k, v] of this.lru) if (v.expiresAt <= now) this.lru.delete(k);
    const res = this.db.prepare(`DELETE FROM response_cache WHERE expires_at <= ?`).run(now);
    return res.changes;
  }

  stats() {
    return {
      enabled: this.opts.enabled,
      ttlMs: this.opts.ttlMs,
      memoryEntries: this.lru.size,
      diskEntries: (this.db.prepare(`SELECT COUNT(*) AS n FROM response_cache`).get() as { n: number }).n,
      hitsMemory: this.hitsMemory,
      hitsDisk: this.hitsDisk,
      misses: this.misses,
    };
  }
}

/** Tiny generic TTL memo used for the /v1/models listing. */
export class TtlValue<T> {
  private value: T | undefined;
  private expiresAt = 0;
  private readonly ttlMs: number;
  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }
  get(compute: () => T): T {
    const now = Date.now();
    if (this.value !== undefined && this.expiresAt > now) return this.value;
    this.value = compute();
    this.expiresAt = now + this.ttlMs;
    return this.value;
  }
  invalidate(): void {
    this.expiresAt = 0;
  }
}
