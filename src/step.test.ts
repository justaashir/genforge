import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { fakeAdapter } from "./adapters/fake";
import {
  BudgetExceededError,
  GateRejectedError,
  PriceUnknownError,
} from "./errors";
import { getStep, listGates, runSpend, setGateVerdict } from "./ledger";
import { run } from "./run";
import { step } from "./step";

const mem = () => new Database(":memory:");

describe("step memoization (the ledger)", () => {
  test("same (runId, key) runs the adapter exactly once; second call returns cached", async () => {
    const db = mem();
    const fake = fakeAdapter({ mode: "sync" });
    const seen: boolean[] = [];
    await run(
      "wf",
      async (ctx) => {
        const a = await step(ctx, "shot", { adapter: fake, input: {} });
        const b = await step(ctx, "shot", { adapter: fake, input: {} });
        seen.push(a.cached, b.cached);
        expect(a.url).toBe(b.url);
      },
      { db }
    );
    expect(fake.counters.submits).toBe(1);
    expect(seen).toEqual([false, true]);
  });

  test("a failed step re-runs on the next attempt (failure does not memoize)", async () => {
    const db = mem();
    const broken = fakeAdapter({ failSubmitTimes: 1, mode: "sync" });
    await expect(
      run("wf", (ctx) => step(ctx, "shot", { adapter: broken, input: {} }), {
        db,
      })
    ).rejects.toThrow("submit failed");
    // failure released the reservation
    const failedRun = latestRunId(db);
    expect(runSpend(db, failedRun)).toBe(0);

    // second attempt resumes the same run and re-submits
    const { runId } = await run(
      "wf",
      (ctx) => step(ctx, "shot", { adapter: broken, input: {} }),
      { db }
    );
    expect(runId).toBe(failedRun);
    expect(broken.counters.submits).toBe(2);
    expect(getStep(db, runId, "shot")?.status).toBe("done");
  });
});

describe("budget", () => {
  test("submit refused when reserved+confirmed would exceed the run ceiling", async () => {
    const db = mem();
    const fake = fakeAdapter({ mode: "sync", usdPerUnit: 0.05 });
    await expect(
      run(
        "wf",
        async (ctx) => {
          ctx.budget(0.08);
          await step(ctx, "a", { adapter: fake, input: {} }); // 0.05 ok
          await step(ctx, "b", { adapter: fake, input: {} }); // 0.10 > 0.08
        },
        { db }
      )
    ).rejects.toThrow(BudgetExceededError);
    expect(fake.counters.submits).toBe(1); // second never submitted
  });

  test("cost is confirmed on success and counts toward spend", async () => {
    const db = mem();
    const fake = fakeAdapter({ mode: "sync", usdPerUnit: 0.25 });
    const { runId } = await run(
      "wf",
      async (ctx) => {
        await step(ctx, "a", { adapter: fake, input: {}, units: 2 });
      },
      { db }
    );
    expect(runSpend(db, runId)).toBeCloseTo(0.5);
  });
});

describe("pricing", () => {
  test("unknown price + no maxCost throws BEFORE submit — nothing is spent", async () => {
    const db = mem();
    const unpriced = fakeAdapter({ mode: "sync", usdPerUnit: null });
    await expect(
      run("wf", (ctx) => step(ctx, "a", { adapter: unpriced, input: {} }), {
        db,
      })
    ).rejects.toThrow(PriceUnknownError);
    expect(unpriced.counters.submits).toBe(0);
  });

  test("unknown price + explicit maxCost proceeds, est = maxCost", async () => {
    const db = mem();
    const unpriced = fakeAdapter({ mode: "sync", usdPerUnit: null });
    const { runId } = await run(
      "wf",
      async (ctx) => {
        const r = await step(ctx, "a", {
          adapter: unpriced,
          input: {},
          maxCost: 0.33,
        });
        expect(r.estUsd).toBe(0.33);
      },
      { db }
    );
    expect(runSpend(db, runId)).toBeCloseTo(0.33);
  });
});

describe("variable cost (actuals)", () => {
  test("adapter-reported actual cost overrides the estimate on confirm", async () => {
    const db = mem();
    // reserved at est 0.50 (maxCost), provider reports actual 0.12
    const fake = fakeAdapter({
      actualUsd: 0.12,
      mode: "sync",
      usdPerUnit: null,
    });
    const { runId } = await run(
      "wf",
      async (ctx) => {
        ctx.budget(0.6);
        await step(ctx, "gpu", { adapter: fake, input: {}, maxCost: 0.5 });
      },
      { db }
    );
    // confirmed at actual, reservation fully released
    expect(runSpend(db, runId)).toBeCloseTo(0.12);
    expect(getStep(db, runId, "gpu")?.cost_usd).toBeCloseTo(0.12);
    expect(getStep(db, runId, "gpu")?.reserved_usd).toBe(0);
  });

  test("budget reserves the worst case upfront, frees headroom after confirm", async () => {
    const db = mem();
    const cheapActual = fakeAdapter({
      actualUsd: 0.05,
      mode: "sync",
      usdPerUnit: null,
    });
    const fixed = fakeAdapter({ mode: "sync", usdPerUnit: 0.4 });
    await run(
      "wf",
      async (ctx) => {
        ctx.budget(0.6);
        // reserves 0.55; after confirm only 0.05 is spent…
        await step(ctx, "a", {
          adapter: cheapActual,
          input: {},
          maxCost: 0.55,
        });
        // …so a 0.40 step now fits (0.05 + 0.40 <= 0.60)
        await step(ctx, "b", { adapter: fixed, input: {} });
      },
      { db }
    );
    expect(fixed.counters.submits).toBe(1);
  });
});

describe("async jobs + resume", () => {
  test("async step polls until done", async () => {
    const db = mem();
    const fake = fakeAdapter({ mode: "async", pollsUntilDone: 3 });
    await run("wf", (ctx) => step(ctx, "vid", { adapter: fake, input: {} }), {
      db,
      pollIntervalMs: 1,
    });
    expect(fake.counters.submits).toBe(1);
    expect(fake.counters.polls).toBe(3);
  });

  test("a step killed after submit re-attaches by jobId — never resubmits", async () => {
    const db = mem();
    // first attempt: submit succeeds, then poll dies (simulated crash mid-poll)
    const fake = fakeAdapter({
      failPollTimes: 1,
      mode: "async",
      pollsUntilDone: 2,
    });
    await expect(
      run("wf", (ctx) => step(ctx, "vid", { adapter: fake, input: {} }), {
        db,
        pollIntervalMs: 1,
      })
    ).rejects.toThrow("poll failed");
    const runId = latestRunId(db);
    // crash left it submitted + resumable, reservation intact
    expect(getStep(db, runId, "vid")?.status).toBe("submitted");
    expect(runSpend(db, runId)).toBeGreaterThan(0);

    // second attempt: same fake (same job server-side) — resumes polling, no new submit
    await run("wf", (ctx) => step(ctx, "vid", { adapter: fake, input: {} }), {
      db,
      pollIntervalMs: 1,
    });
    expect(fake.counters.submits).toBe(1);
    expect(getStep(db, runId, "vid")?.status).toBe("done");
  });

  test("sync adapter result completes immediately without a poll loop", async () => {
    const db = mem();
    const fake = fakeAdapter({ mode: "sync" });
    await run("wf", (ctx) => step(ctx, "img", { adapter: fake, input: {} }), {
      db,
    });
    expect(fake.counters.polls).toBe(0);
  });
});

describe("approveOver — cost approval gate", () => {
  test("step above threshold blocks on an approval gate, submits after keep", async () => {
    const db = mem();
    const fake = fakeAdapter({ mode: "sync", usdPerUnit: 2 });
    const running = run(
      "wf",
      (ctx) => step(ctx, "big", { adapter: fake, approveOver: 1.0, input: {} }),
      { db, pollIntervalMs: 1 }
    );
    // wait for the gate row to appear, then approve it
    const gateRow = await waitForGate(db, "approve:big");
    expect(fake.counters.submits).toBe(0); // blocked, nothing spent
    setGateVerdict(db, gateRow.id, "keep");
    await running;
    expect(fake.counters.submits).toBe(1);
  });

  test("rejecting the approval gate aborts the step — zero submits", async () => {
    const db = mem();
    const fake = fakeAdapter({ mode: "sync", usdPerUnit: 2 });
    const running = run(
      "wf",
      (ctx) => step(ctx, "big", { adapter: fake, approveOver: 1.0, input: {} }),
      { db, pollIntervalMs: 1 }
    );
    const gateRow = await waitForGate(db, "approve:big");
    setGateVerdict(db, gateRow.id, "reject");
    await expect(running).rejects.toThrow(GateRejectedError);
    expect(fake.counters.submits).toBe(0);
  });
});

function latestRunId(db: Database): string {
  const row = db
    .query("SELECT id FROM runs ORDER BY rowid DESC LIMIT 1")
    .get() as { id: string } | null;
  if (!row) {
    throw new Error("no runs");
  }
  return row.id;
}

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
