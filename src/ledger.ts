import type { Database } from "bun:sqlite";

export type StepRow = {
  id: number;
  run_id: string;
  key: string;
  status: "pending" | "submitted" | "done" | "failed";
  provider: string;
  model: string;
  input_json: string | null;
  units: number;
  est_usd: number;
  reserved_usd: number;
  cost_usd: number | null;
  provider_job_id: string | null;
  artifact_url: string | null;
  artifact_path: string | null;
  content_type: string | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
};

export type GateRow = {
  id: number;
  run_id: string;
  key: string;
  evidence_json: string | null;
  verdict: "keep" | "reject" | null;
  note: string | null;
  created_at: string;
  decided_at: string | null;
};

export type RunRow = {
  id: string;
  workflow: string;
  status: "running" | "done" | "failed" | "rejected";
  budget_usd: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

// -- steps ---------------------------------------------------------------

export function getStep(
  db: Database,
  runId: string,
  key: string
): StepRow | null {
  return db
    .query("SELECT * FROM steps WHERE run_id = ? AND key = ?")
    .get(runId, key) as StepRow | null;
}

export function insertStep(
  db: Database,
  row: {
    runId: string;
    key: string;
    provider: string;
    model: string;
    inputJson: string;
    units: number;
    estUsd: number;
  }
): number {
  const inserted = db
    .query(
      `INSERT INTO steps (run_id, key, provider, model, input_json, units, est_usd, reserved_usd, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
       ON CONFLICT(run_id, key) DO UPDATE SET
         status = 'pending', provider = excluded.provider, model = excluded.model,
         input_json = excluded.input_json, units = excluded.units,
         est_usd = excluded.est_usd, reserved_usd = excluded.reserved_usd,
         cost_usd = NULL, provider_job_id = NULL, error = NULL, completed_at = NULL
       RETURNING id`
    )
    .get(
      row.runId,
      row.key,
      row.provider,
      row.model,
      row.inputJson,
      row.units,
      row.estUsd,
      row.estUsd
    ) as { id: number };
  return inserted.id;
}

export function markSubmitted(
  db: Database,
  stepId: number,
  jobId: string
): void {
  db.query(
    "UPDATE steps SET status = 'submitted', provider_job_id = ? WHERE id = ?"
  ).run(jobId, stepId);
}

export function markDone(
  db: Database,
  stepId: number,
  fields: {
    costUsd: number;
    artifactUrl: string;
    artifactPath: string | null;
    contentType: string | null;
  }
): void {
  db.query(
    `UPDATE steps SET status = 'done', cost_usd = ?, reserved_usd = 0,
       artifact_url = ?, artifact_path = ?, content_type = ?,
       completed_at = datetime('now')
     WHERE id = ?`
  ).run(
    fields.costUsd,
    fields.artifactUrl,
    fields.artifactPath,
    fields.contentType,
    stepId
  );
}

export function markFailed(db: Database, stepId: number, error: string): void {
  db.query(
    `UPDATE steps SET status = 'failed', reserved_usd = 0, error = ?,
       completed_at = datetime('now')
     WHERE id = ?`
  ).run(error, stepId);
}

export function listSteps(db: Database, runId?: string): StepRow[] {
  if (runId) {
    return db
      .query("SELECT * FROM steps WHERE run_id = ? ORDER BY id")
      .all(runId) as StepRow[];
  }
  return db.query("SELECT * FROM steps ORDER BY id DESC").all() as StepRow[];
}

// -- spend ---------------------------------------------------------------

/** Confirmed cost + live reservations for one run. The budget check reads this. */
export function runSpend(db: Database, runId: string): number {
  const row = db
    .query(
      "SELECT COALESCE(SUM(COALESCE(cost_usd, 0) + reserved_usd), 0) AS total FROM steps WHERE run_id = ?"
    )
    .get(runId) as { total: number };
  return row.total;
}

/** Confirmed cost + live reservations across every run in the ledger. */
export function totalSpend(db: Database): number {
  const row = db
    .query(
      "SELECT COALESCE(SUM(COALESCE(cost_usd, 0) + reserved_usd), 0) AS total FROM steps"
    )
    .get() as { total: number };
  return row.total;
}

// -- gates ---------------------------------------------------------------

export function getGate(
  db: Database,
  runId: string,
  key: string
): GateRow | null {
  return db
    .query("SELECT * FROM gates WHERE run_id = ? AND key = ?")
    .get(runId, key) as GateRow | null;
}

export function insertGate(
  db: Database,
  runId: string,
  key: string,
  evidenceJson: string
): GateRow {
  return db
    .query(
      `INSERT INTO gates (run_id, key, evidence_json) VALUES (?, ?, ?)
       ON CONFLICT(run_id, key) DO UPDATE SET evidence_json = excluded.evidence_json
       RETURNING *`
    )
    .get(runId, key, evidenceJson) as GateRow;
}

export function setGateVerdict(
  db: Database,
  gateId: number,
  verdict: "keep" | "reject",
  note?: string
): void {
  db.query(
    "UPDATE gates SET verdict = ?, note = ?, decided_at = datetime('now') WHERE id = ?"
  ).run(verdict, note ?? null, gateId);
}

/** Clear a decided gate so the step/review can run again (the UI's "regenerate"). */
export function clearGate(db: Database, gateId: number): void {
  db.query(
    "UPDATE gates SET verdict = NULL, note = NULL, decided_at = NULL WHERE id = ?"
  ).run(gateId);
}

export function listGates(db: Database, pendingOnly = false): GateRow[] {
  if (pendingOnly) {
    return db
      .query("SELECT * FROM gates WHERE verdict IS NULL ORDER BY id")
      .all() as GateRow[];
  }
  return db.query("SELECT * FROM gates ORDER BY id DESC").all() as GateRow[];
}

// -- runs ----------------------------------------------------------------

export function getRun(db: Database, runId: string): RunRow | null {
  return db
    .query("SELECT * FROM runs WHERE id = ?")
    .get(runId) as RunRow | null;
}

export function listRuns(db: Database): RunRow[] {
  return db
    .query("SELECT * FROM runs ORDER BY created_at DESC")
    .all() as RunRow[];
}
