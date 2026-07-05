import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { GateRejectedError, GateTimeoutError } from "./errors";
import { gate } from "./gate";
import { listGates, setGateVerdict } from "./ledger";
import { run } from "./run";

const mem = () => new Database(":memory:");

async function waitForGate(db: Database, key: string) {
  for (let i = 0; i < 500; i += 1) {
    const g = listGates(db).find((x) => x.key === key);
    if (g) {
      return g;
    }
    await Bun.sleep(2);
  }
  throw new Error(`gate ${key} never appeared`);
}

describe("gate", () => {
  test("blocks until a keep verdict appears, then returns it", async () => {
    const db = mem();
    const running = run(
      "wf",
      async (ctx) => {
        const v = await gate(ctx, "review", { note: "check the tote" });
        return v.verdict;
      },
      { db, pollIntervalMs: 1 }
    );
    const g = await waitForGate(db, "review");
    expect(g.verdict).toBeNull();
    setGateVerdict(db, g.id, "keep", "looks great");
    const { result } = await running;
    expect(result).toBe("keep");
  });

  test("reject throws GateRejectedError and marks the run rejected", async () => {
    const db = mem();
    const running = run("wf", (ctx) => gate(ctx, "review"), {
      db,
      pollIntervalMs: 1,
    });
    const g = await waitForGate(db, "review");
    setGateVerdict(db, g.id, "reject", "logo warped");
    await expect(running).rejects.toThrow(GateRejectedError);
    const row = db.query("SELECT status FROM runs LIMIT 1").get() as {
      status: string;
    };
    expect(row.status).toBe("rejected");
  });

  test("an already-decided gate returns instantly on resume (sticky verdict)", async () => {
    const db = mem();
    const first = run("wf", (ctx) => gate(ctx, "review"), {
      db,
      pollIntervalMs: 1,
    });
    const g = await waitForGate(db, "review");
    setGateVerdict(db, g.id, "keep");
    await first;

    // a brand-new run of the same workflow gets its own gate; but resuming the
    // same run (explicit runId) sees the sticky verdict without blocking
    const runId = (
      db.query("SELECT id FROM runs LIMIT 1").get() as {
        id: string;
      }
    ).id;
    const { result } = await run("wf", (ctx) => gate(ctx, "review"), {
      db,
      pollIntervalMs: 1,
      runId,
    });
    expect(result.verdict).toBe("keep");
  });

  test("timeout throws GateTimeoutError — a gate is NEVER auto-approved", async () => {
    const db = mem();
    await expect(
      run("wf", (ctx) => gate(ctx, "review", { timeoutMs: 20 }), {
        db,
        pollIntervalMs: 1,
      })
    ).rejects.toThrow(GateTimeoutError);
    // gate row still pending — no implicit verdict was written
    const g = listGates(db).find((x) => x.key === "review");
    expect(g?.verdict).toBeNull();
  });

  test("evidence pack is stored on the gate row for the review UI", async () => {
    const db = mem();
    const running = run(
      "wf",
      (ctx) =>
        gate(ctx, "review", {
          evidence: { estUsd: 1.68, model: "kling-v3" },
          note: "hook shot v2",
        }),
      { db, pollIntervalMs: 1 }
    );
    const g = await waitForGate(db, "review");
    const evidence = JSON.parse(g.evidence_json ?? "{}");
    expect(evidence.note).toBe("hook shot v2");
    expect(evidence.estUsd).toBe(1.68);
    setGateVerdict(db, g.id, "keep");
    await running;
  });
});
