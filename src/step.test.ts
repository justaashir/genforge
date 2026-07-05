import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeAdapter } from "./adapters/fake";
import type { Ctx } from "./context";
import {
  BudgetExceededError,
  GateRejectedError,
  JobFailedError,
  PriceUnknownError,
} from "./errors";
import {
  getStep,
  insertStep,
  listGates,
  markDone,
  runSpend,
  setGateVerdict,
} from "./ledger";
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
        expect(r.costUsd).toBe(0.33);
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

describe("re-attach failure semantics", () => {
  test("terminal failure on re-attach marks the step failed — and it re-runs cleanly", async () => {
    const db = mem();
    // attempt 1: submit lands, then a transient poll error (simulated crash)
    // attempt 2: re-attach discovers the job failed terminally
    const fake = fakeAdapter({
      failPollTerminalTimes: 1,
      failPollTimes: 1,
      mode: "async",
    });
    const wf = (ctx: Ctx) => step(ctx, "vid", { adapter: fake, input: {} });

    await expect(run("wf", wf, { db, pollIntervalMs: 1 })).rejects.toThrow(
      "poll failed"
    );
    const runId = latestRunId(db);
    expect(getStep(db, runId, "vid")?.status).toBe("submitted");

    await expect(run("wf", wf, { db, pollIntervalMs: 1 })).rejects.toThrow(
      JobFailedError
    );
    expect(getStep(db, runId, "vid")?.status).toBe("failed");
    expect(runSpend(db, runId)).toBe(0); // reservation released, nothing billed

    // attempt 3: failed step re-runs with a fresh submit and completes
    await run("wf", wf, { db, pollIntervalMs: 1 });
    expect(fake.counters.submits).toBe(2);
    expect(getStep(db, runId, "vid")?.status).toBe("done");
  });

  test("re-attach never re-prices — resumes even when the price is now unknown", async () => {
    const db = mem();
    const priced = fakeAdapter({
      failPollTimes: 1,
      mode: "async",
      usdPerUnit: 0.4,
    });
    await expect(
      run("wf", (ctx) => step(ctx, "vid", { adapter: priced, input: {} }), {
        db,
        pollIntervalMs: 1,
      })
    ).rejects.toThrow("poll failed");
    const runId = latestRunId(db);

    // same provider job, but the price is no longer resolvable and no maxCost:
    // a fresh submit would throw PriceUnknownError — a re-attach must not
    const unpriced = fakeAdapter({ mode: "async", usdPerUnit: null });
    await run(
      "wf",
      (ctx) => step(ctx, "vid", { adapter: unpriced, input: {} }),
      {
        db,
        pollIntervalMs: 1,
      }
    );
    expect(unpriced.counters.submits).toBe(0); // re-attached, not resubmitted
    // settled at the estimate that was actually reserved at submit time
    expect(getStep(db, runId, "vid")?.cost_usd).toBeCloseTo(0.4);
  });

  test("a terminally failed job that still billed keeps its cost on the ledger", async () => {
    const db = mem();
    const fake = fakeAdapter({
      actualUsd: 0.07,
      failPollTerminalTimes: 1,
      mode: "async",
    });
    const wf = (ctx: Ctx) => step(ctx, "vid", { adapter: fake, input: {} });

    await expect(run("wf", wf, { db, pollIntervalMs: 1 })).rejects.toThrow(
      JobFailedError
    );
    const runId = latestRunId(db);
    const failed = getStep(db, runId, "vid");
    expect(failed?.status).toBe("failed");
    expect(failed?.cost_usd).toBeCloseTo(0.07);
    expect(runSpend(db, runId)).toBeCloseTo(0.07);

    // the re-run's success doesn't erase the billed failure: it becomes waste
    await run("wf", wf, { db, pollIntervalMs: 1 });
    expect(getStep(db, runId, "vid")?.waste_usd).toBeCloseTo(0.07);
    expect(runSpend(db, runId)).toBeCloseTo(0.14);
  });
});

describe("artifact download vs money truth", () => {
  test("a failed download never re-bills: cost recorded first, download retried free on resume", async () => {
    const db = mem();
    const dir = mkdtempSync(join(tmpdir(), "genforge-step-"));
    let failures = 1;
    const server = Bun.serve({
      fetch: () => {
        if (failures > 0) {
          failures -= 1;
          return new Response("blip", { status: 500 });
        }
        return new Response("bytes", {
          headers: { "content-type": "image/png" },
        });
      },
      port: 0,
    });
    const fake = fakeAdapter({
      mode: "sync",
      outputUrl: `http://localhost:${server.port}/a.png`,
      usdPerUnit: 0.3,
    });
    const wf = (ctx: Ctx) => step(ctx, "img", { adapter: fake, input: {} });

    try {
      await expect(run("wf", wf, { artifactsDir: dir, db })).rejects.toThrow(
        "artifact download failed"
      );
      const runId = latestRunId(db);
      const row = getStep(db, runId, "img");
      expect(row?.status).toBe("done"); // money truth landed before the download
      expect(row?.cost_usd).toBeCloseTo(0.3);
      expect(row?.artifact_path).toBeNull();

      // resume: replay retries the download without touching the provider
      const { result } = await run("wf", async (ctx) => await wf(ctx), {
        artifactsDir: dir,
        db,
      });
      expect(fake.counters.submits).toBe(1); // never re-billed
      expect(result.cached).toBeTrue();
      expect(result.path).toBeTruthy();
      expect(getStep(db, runId, "img")?.artifact_path).toBeTruthy();
      expect(runSpend(db, runId)).toBeCloseTo(0.3);
    } finally {
      server.stop(true);
    }
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

  test("budget is re-checked after the approval wait — stale approvals can't overspend", async () => {
    const db = mem();
    const fake = fakeAdapter({ mode: "sync", usdPerUnit: 2 });
    const running = run(
      "wf",
      async (ctx) => {
        ctx.budget(3);
        await step(ctx, "big", { adapter: fake, approveOver: 1, input: {} });
      },
      { db, pollIntervalMs: 1 }
    );
    const gateRow = await waitForGate(db, "approve:big");
    // money lands elsewhere in the run while the human deliberates
    const otherId = insertStep(db, {
      estUsd: 2,
      inputJson: "null",
      key: "other",
      model: "m",
      provider: "p",
      runId: latestRunId(db),
      units: 1,
    });
    markDone(db, otherId, { artifactUrl: "x", contentType: null, costUsd: 2 });
    setGateVerdict(db, gateRow.id, "keep");
    await expect(running).rejects.toThrow(BudgetExceededError);
    expect(fake.counters.submits).toBe(0); // approved, but no longer affordable
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
