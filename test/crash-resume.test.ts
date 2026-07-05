import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE = join(import.meta.dir, "crash-resume.fixture.ts");

describe("crash-resume (real process kill)", () => {
  test(
    "SIGKILL mid-generation, re-run: job submitted exactly once, run completes",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "genforge-crash-"));
      const dbPath = join(dir, "ledger.sqlite");

      // first attempt: kill it while the (slow) job is still rendering
      const first = Bun.spawn(["bun", FIXTURE, dbPath], {
        stderr: "pipe",
        stdout: "pipe",
      });
      await waitForSubmittedStep(dbPath);
      first.kill(9);
      await first.exited;

      // the ledger preserved the in-flight job
      const db = new Database(dbPath, { readonly: true });
      const afterCrash = db
        .query("SELECT status, provider_job_id FROM steps")
        .get() as { status: string; provider_job_id: string | null };
      expect(afterCrash.status).toBe("submitted");
      expect(afterCrash.provider_job_id).not.toBeNull();
      db.close();

      // second attempt: must re-attach and finish without a second submit
      const second = Bun.spawn(["bun", FIXTURE, dbPath], {
        stderr: "pipe",
        stdout: "pipe",
      });
      const out = await new Response(second.stdout).text();
      expect(await second.exited).toBe(0);
      expect(out).toContain("WORKFLOW_DONE");

      const verify = new Database(dbPath, { readonly: true });
      const jobs = verify
        .query("SELECT COUNT(*) AS n FROM fake_jobs")
        .get() as {
        n: number;
      };
      const stepRow = verify
        .query("SELECT status, cost_usd FROM steps")
        .get() as { status: string; cost_usd: number };
      const runRow = verify.query("SELECT status FROM runs").get() as {
        status: string;
      };
      verify.close();

      expect(jobs.n).toBe(1); // THE invariant: money was spent exactly once
      expect(stepRow.status).toBe("done");
      expect(stepRow.cost_usd).toBeCloseTo(0.5);
      expect(runRow.status).toBe("done");
    },
    { timeout: 20_000 }
  );
});

async function waitForSubmittedStep(dbPath: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    await Bun.sleep(25);
    try {
      const db = new Database(dbPath, { readonly: true });
      const row = db
        .query("SELECT status FROM steps WHERE status = 'submitted'")
        .get();
      db.close();
      if (row) {
        return;
      }
    } catch {
      // db may not exist yet
    }
  }
  throw new Error("step never reached 'submitted'");
}
