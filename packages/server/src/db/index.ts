import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { PRAGMAS, SCHEMA_VERSION, TABLES, buildCreateTableSql } from "./schema.ts";
import { logger } from "../log.ts";

const log = logger("db");

export type Db = Database.Database;

export function openDatabase(dbPath: string): Db {
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  for (const p of PRAGMAS) db.pragma(p.replace(/^PRAGMA\s+/i, ""));
  migrate(db);
  return db;
}

/** Create-if-missing + additive column sync. Safe to run on every boot. */
export function migrate(db: Db): void {
  db.transaction(() => {
    for (const [name, def] of Object.entries(TABLES)) {
      for (const sql of buildCreateTableSql(name, def)) db.exec(sql);
    }
    for (const [name, def] of Object.entries(TABLES)) {
      const existing = new Set(
        (db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>).map((r) => r.name),
      );
      for (const [col, type] of Object.entries(def.columns)) {
        if (existing.has(col)) continue;
        // PRIMARY KEY / UNIQUE are illegal in ADD COLUMN; strip them.
        const safe = type.replace(/\bPRIMARY KEY\b/gi, "").replace(/\bUNIQUE\b/gi, "").replace(/\bAUTOINCREMENT\b/gi, "").trim();
        log.info(`altering ${name}: add column ${col}`);
        db.exec(`ALTER TABLE "${name}" ADD COLUMN "${col}" ${safe}`);
      }
    }
    db.prepare(`INSERT INTO meta(key, value) VALUES('schemaVersion', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(SCHEMA_VERSION));
  })();
}

export function getMeta(db: Db, key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare(`INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
    key,
    value,
  );
}
