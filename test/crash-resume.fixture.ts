// Fixture for the crash-resume integration test. Runs a workflow whose fake
// "provider" lives in the sqlite db itself, so submits survive across
// processes: submit inserts a row into fake_jobs, poll reads it back.
// The test SIGKILLs this process mid-poll, re-runs it, and asserts the job
// was submitted exactly once.
import { Database } from "bun:sqlite";
import type { Adapter } from "../src/adapters/types";
import { run, step } from "../src/index";

const [, , dbPath] = process.argv;
if (!dbPath) {
  throw new Error("usage: bun crash-resume.fixture.ts <db-path>");
}
const db = new Database(dbPath, { create: true });
db.exec(`CREATE TABLE IF NOT EXISTS fake_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  done_after TEXT NOT NULL
)`);

const SLOW_JOB_MS = 1500;

const adapter: Adapter = {
  model: "fake/slow-video",
  poll: (jobId: string) => {
    const row = db
      .query("SELECT done_after FROM fake_jobs WHERE id = ?")
      .get(Number(jobId)) as { done_after: string } | null;
    if (!row) {
      throw new Error(`no such job ${jobId}`);
    }
    if (Date.now() < Number(row.done_after)) {
      return Promise.resolve({ status: "running" as const });
    }
    return Promise.resolve({
      output: { url: `fake://done/${jobId}` },
      status: "done" as const,
    });
  },
  price: () =>
    Promise.resolve({
      source: "static" as const,
      unit: "second",
      usdPerUnit: 0.1,
    }),
  provider: "crashfake",
  submit: () => {
    const inserted = db
      .query("INSERT INTO fake_jobs (done_after) VALUES (?) RETURNING id")
      .get(String(Date.now() + SLOW_JOB_MS)) as { id: number };
    return Promise.resolve({
      jobId: String(inserted.id),
      kind: "job" as const,
    });
  },
};

await run(
  "crash-wf",
  async (ctx) => {
    await step(ctx, "slow-video", {
      adapter,
      input: { prompt: "x" },
      units: 5,
    });
  },
  { db, pollIntervalMs: 50 }
);

// signal clean completion to the test
console.log("WORKFLOW_DONE");
