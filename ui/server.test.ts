import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { fakeAdapter } from "../src/adapters/fake";
import { openDb } from "../src/db";
import { run, step } from "../src/index";
import { serveUi } from "./server";

describe("review UI server", () => {
  const db = openDb(new Database(":memory:"));
  const server = serveUi(db, 0);
  const base = `http://localhost:${server.port}`;
  afterAll(() => server.stop(true));

  test("serves the review page", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("genforge");
  });

  test("state reflects runs/steps/spend; verdict endpoint unblocks a gate", async () => {
    const fake = fakeAdapter({ mode: "sync", usdPerUnit: 0.2 });
    const running = run(
      "ui-wf",
      async (ctx) => {
        await step(ctx, "shot", {
          adapter: fake,
          approveOver: 0.1, // 0.2 > 0.1 → approval gate blocks
          input: {},
        });
      },
      { db, pollIntervalMs: 1 }
    );

    // wait until the gate shows up in the API
    let gateId = 0;
    for (let i = 0; i < 500 && !gateId; i += 1) {
      const state = (await (await fetch(`${base}/api/state`)).json()) as {
        gates: Array<{ id: number; verdict: string | null }>;
      };
      gateId = state.gates.find((g) => !g.verdict)?.id ?? 0;
      if (!gateId) {
        await Bun.sleep(2);
      }
    }
    expect(gateId).toBeGreaterThan(0);

    const post = await fetch(`${base}/api/gates/${gateId}/verdict`, {
      body: JSON.stringify({ verdict: "keep" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(post.status).toBe(200);
    await running; // workflow unblocked and finished

    const state = (await (await fetch(`${base}/api/state`)).json()) as {
      runs: Array<{ status: string }>;
      totalSpend: number;
    };
    expect(state.runs[0]?.status).toBe("done");
    expect(state.totalSpend).toBeCloseTo(0.2);
  });

  test("cross-origin requests are refused — a webpage can't CSRF a keep verdict", async () => {
    const res = await fetch(`${base}/api/gates/1/verdict`, {
      body: JSON.stringify({ verdict: "keep" }),
      headers: { origin: "http://evil.example" },
      method: "POST",
    });
    expect(res.status).toBe(403);
    // localhost origins (the UI itself) still pass
    const ok = await fetch(`${base}/api/state`, {
      headers: { origin: `http://localhost:${server.port}` },
    });
    expect(ok.status).toBe(200);
  });

  test("rejects a malformed verdict", async () => {
    const res = await fetch(`${base}/api/gates/1/verdict`, {
      body: JSON.stringify({ verdict: "maybe" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(res.status).toBe(400);
  });
});
