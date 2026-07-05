import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { GateRejectedError } from "./errors";
import { gate } from "./gate";
import { listGates, setGateVerdict } from "./ledger";
import { run } from "./run";

const mem = () => new Database(":memory:");

describe("run lifecycle + resume semantics", () => {
  test("a completed run is marked done and returns the fn result", async () => {
    const db = mem();
    const { runId, result } = await run("wf", () => Promise.resolve(42), {
      db,
    });
    const row = db.query("SELECT status FROM runs WHERE id = ?").get(runId) as {
      status: string;
    };
    expect(row.status).toBe("done");
    expect(result).toBe(42);
  });

  test("re-running the same workflow resumes the latest incomplete run", async () => {
    const db = mem();
    await expect(
      run("wf", () => Promise.reject(new Error("boom")), { db })
    ).rejects.toThrow("boom");
    const failed = (db.query("SELECT id FROM runs").get() as { id: string }).id;

    const { runId } = await run("wf", () => Promise.resolve("ok"), { db });
    expect(runId).toBe(failed); // resumed, not a new run
  });

  test("a done run is NOT resumed — re-invoking starts a fresh run", async () => {
    const db = mem();
    const first = await run("wf", () => Promise.resolve(1), { db });
    const second = await run("wf", () => Promise.resolve(2), { db });
    expect(second.runId).not.toBe(first.runId);
  });

  test("fresh: true forces a new run even with an incomplete one pending", async () => {
    const db = mem();
    await expect(
      run("wf", () => Promise.reject(new Error("boom")), { db })
    ).rejects.toThrow("boom");
    const { runId } = await run("wf", () => Promise.resolve("ok"), {
      db,
      fresh: true,
    });
    const count = (
      db.query("SELECT COUNT(*) AS n FROM runs").get() as { n: number }
    ).n;
    expect(count).toBe(2);
    const statuses = db.query("SELECT id, status FROM runs").all() as Array<{
      id: string;
      status: string;
    }>;
    expect(statuses.find((r) => r.id === runId)?.status).toBe("done");
  });

  test("a rejected run is NOT auto-resumed — the sticky verdict can't brick the workflow", async () => {
    const db = mem();
    const first = run("wf", (ctx) => gate(ctx, "review"), {
      db,
      pollIntervalMs: 1,
    });
    for (let i = 0; i < 500 && listGates(db).length === 0; i += 1) {
      await Bun.sleep(2);
    }
    const [g] = listGates(db);
    if (!g) {
      throw new Error("gate never appeared");
    }
    setGateVerdict(db, g.id, "reject");
    await expect(first).rejects.toThrow(GateRejectedError);
    const { id: rejectedId } = db.query("SELECT id FROM runs").get() as {
      id: string;
    };

    // the next default invocation starts fresh instead of rethrowing forever
    const { runId } = await run("wf", () => Promise.resolve("ok"), { db });
    expect(runId).not.toBe(rejectedId);
  });

  test("different workflows never share runs", async () => {
    const db = mem();
    await expect(
      run("wf-a", () => Promise.reject(new Error("boom")), { db })
    ).rejects.toThrow("boom");
    const { runId } = await run("wf-b", () => Promise.resolve("ok"), { db });
    const a = db.query("SELECT workflow FROM runs WHERE id = ?").get(runId) as {
      workflow: string;
    };
    expect(a.workflow).toBe("wf-b");
  });

  test("ctx.budget writes the ceiling onto the run row", async () => {
    const db = mem();
    const { runId } = await run(
      "wf",
      (ctx) => {
        ctx.budget(12.5);
        return Promise.resolve();
      },
      { db }
    );
    const row = db
      .query("SELECT budget_usd FROM runs WHERE id = ?")
      .get(runId) as { budget_usd: number };
    expect(row.budget_usd).toBe(12.5);
  });
});
