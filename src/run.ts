import type { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import type { Ctx } from "./context";
import { DEFAULT_DB_PATH, openDb } from "./db";
import { GateRejectedError } from "./errors";

export type RunOptions = {
  /** Database instance or file path. Default .genforge/genforge.sqlite */
  db?: Database | string;
  /** Resume a specific run. Default: latest incomplete run of this workflow, else new. */
  runId?: string;
  /** Force a brand-new run even if an incomplete one exists. */
  fresh?: boolean;
  pollIntervalMs?: number;
  artifactsDir?: string;
};

export type RunHandle<T> = { runId: string; result: T };

/**
 * Execute a workflow fn with durable-step context. Re-invoking the same
 * workflow resumes its latest incomplete run — completed steps replay from
 * the ledger, pending gates block again, in-flight jobs re-attach.
 */
export async function run<T>(
  workflow: string,
  fn: (ctx: Ctx) => Promise<T> | T,
  opts: RunOptions = {}
): Promise<RunHandle<T>> {
  const db = openDb(opts.db);
  const runId = resolveRunId(db, workflow, opts);

  const ctx: Ctx = {
    artifactsDir: opts.artifactsDir ?? defaultArtifactsDir(opts.db),
    budget: (usd: number) => {
      db.query(
        "UPDATE runs SET budget_usd = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(usd, runId);
    },
    db,
    pollIntervalMs: opts.pollIntervalMs ?? 2000,
    runId,
    workflow,
  };

  try {
    const result = await fn(ctx);
    setStatus(db, runId, "done", null);
    return { result, runId };
  } catch (err) {
    setStatus(
      db,
      runId,
      err instanceof GateRejectedError ? "rejected" : "failed",
      String(err)
    );
    throw err;
  }
}

function resolveRunId(
  db: Database,
  workflow: string,
  opts: RunOptions
): string {
  if (opts.runId) {
    ensureRun(db, opts.runId, workflow);
    return opts.runId;
  }
  if (!opts.fresh) {
    // 'rejected' is deliberately excluded: a human said no, and the verdict is
    // sticky — auto-resuming would just rethrow forever. Resume a rejected run
    // explicitly by runId (after clearing the gate) if that's really wanted.
    const incomplete = db
      .query(
        `SELECT id FROM runs WHERE workflow = ? AND status NOT IN ('done', 'rejected')
         ORDER BY created_at DESC, rowid DESC LIMIT 1`
      )
      .get(workflow) as { id: string } | null;
    if (incomplete) {
      setStatus(db, incomplete.id, "running", null);
      return incomplete.id;
    }
  }
  const runId = crypto.randomUUID();
  ensureRun(db, runId, workflow);
  return runId;
}

function ensureRun(db: Database, runId: string, workflow: string): void {
  db.query(
    `INSERT INTO runs (id, workflow) VALUES (?, ?)
     ON CONFLICT(id) DO UPDATE SET status = 'running', error = NULL, updated_at = datetime('now')`
  ).run(runId, workflow);
}

function setStatus(
  db: Database,
  runId: string,
  status: string,
  error: string | null
): void {
  db.query(
    "UPDATE runs SET status = ?, error = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(status, error, runId);
}

function defaultArtifactsDir(dbOpt: RunOptions["db"]): string {
  if (typeof dbOpt === "string" && dbOpt !== ":memory:") {
    return join(dirname(dbOpt), "artifacts");
  }
  return join(dirname(DEFAULT_DB_PATH), "artifacts");
}
