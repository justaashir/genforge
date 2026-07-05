import type { Database } from "bun:sqlite";

/** Handed to the workflow fn by run(); threaded through step() and gate(). */
export type Ctx = {
  db: Database;
  runId: string;
  workflow: string;
  artifactsDir: string;
  pollIntervalMs: number;
  /** Set a hard USD ceiling for this run — enforced client-side before every submit. */
  budget: (usd: number) => void;
};
