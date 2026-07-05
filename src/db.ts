import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_DB_PATH = ".genforge/genforge.sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  workflow TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running', -- running | done | failed | rejected
  budget_usd REAL,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | submitted | done | failed
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_json TEXT,
  units REAL NOT NULL DEFAULT 1,
  est_usd REAL NOT NULL,
  reserved_usd REAL NOT NULL DEFAULT 0, -- released on failure, zeroed when cost confirms
  cost_usd REAL,                        -- confirmed on success
  provider_job_id TEXT,                 -- the crash-safe resume handle
  artifact_url TEXT,
  artifact_path TEXT,
  content_type TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  UNIQUE(run_id, key)
);

CREATE TABLE IF NOT EXISTS gates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  key TEXT NOT NULL,
  evidence_json TEXT,
  verdict TEXT, -- keep | reject | NULL (pending)
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT,
  UNIQUE(run_id, key)
);

CREATE TABLE IF NOT EXISTS prices (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  unit TEXT NOT NULL,
  usd_per_unit REAL NOT NULL,
  source TEXT NOT NULL, -- live | static
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (provider, model)
);
`;

/** Open (or adopt) a database and ensure the schema exists. Idempotent. */
export function openDb(dbOrPath?: Database | string): Database {
  if (dbOrPath instanceof Database) {
    dbOrPath.exec(SCHEMA);
    return dbOrPath;
  }
  const path = dbOrPath ?? DEFAULT_DB_PATH;
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}
