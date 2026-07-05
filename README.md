# genforge

**Spend-aware durable steps for paid AI APIs.** Every generation is priced
before it runs, recorded forever, resumable after a crash, and blockable by
budget or human review. Zero infra: one SQLite file, no server, no queue, no
second bill.

```ts
import { run, step, gate } from "genforge";
import { fal } from "genforge/adapters/fal";

await run("product-ad", async (ctx) => {
  ctx.budget(5.00); // hard USD ceiling, enforced before every submit

  const board = await step(ctx, "storyboard", {
    adapter: fal("fal-ai/nano-banana-pro/edit"),
    input: { prompt: "4-panel storyboard…", aspect_ratio: "9:16" },
    units: 1,
  });

  await gate(ctx, "review-storyboard", { artifact: board }); // blocks until you click keep

  const video = await step(ctx, "full-ad", {
    adapter: fal("fal-ai/kling-video/v3/pro/image-to-video"),
    input: { start_image_url: board.url, duration: "15" },
    units: 15,
    approveOver: 1.00, // anything over $1 needs an explicit yes
  });

  await gate(ctx, "review-video", { artifact: video });
});
```

```bash
bun pipeline.ts       # run it — crash it anywhere, re-run to resume
bunx genforge dev     # review UI: pending gates, artifact previews, live spend
```

## Why

If you build on fal.ai, Replicate, OpenAI images/TTS, or ElevenLabs, you end up
hand-rolling the same four things everyone hand-rolls after their first
surprise bill:

1. **Cost before spend.** No provider enforces a budget for you — not one.
   `step()` resolves the real price (fal's live pricing API, or a shipped
   community price table), refuses to run past your ceiling, and an unknown
   price is never treated as free: it demands an explicit `maxCost`.
2. **A durable ledger.** Every call is a row: params, estimate, actual cost,
   provider job id, artifact. `SUM(cost_usd)` is your bill, queryable in sqlite.
3. **Crash-safe resume.** Steps are memoized by `(run, key)`. Completed steps
   replay free from the ledger; an in-flight async job re-attaches by its
   provider request id. Kill -9 mid-generation and re-run: **money is spent
   exactly once** (that's an integration test, not a promise). One honest
   caveat: a crash in the instant between the provider accepting a submit
   and the jobId reaching disk re-submits on resume — closing it needs
   provider-side idempotency keys, which none of these APIs offer. Sync
   providers (one request, no jobId) share the same window for the request
   itself.
4. **Human review as a pipeline primitive.** `gate()` blocks until you click
   keep/reject in a local UI — with the artifact, the note, and the cost in
   front of you. Timeouts never auto-approve. Expensive steps can require
   approval *before* submitting (`approveOver`).

## What it is not

No workflow server (Temporal needs a cluster; this needs a file). No metered
runtime stacking a second bill on top of your provider's (Inngest bills per
step, Trigger.dev bills wall-clock while you wait on an LLM; this is a library
— it bills nothing). No DSL, no graph builder, no agent loop: your pipeline is
a plain typed async function, and genforge is three calls inside it.

## Adapters

| Provider | Kind | Pricing |
|---|---|---|
| `genforge/adapters/fal` | async queue | **live** (fal pricing API, 24h cache) |
| `genforge/adapters/replicate` | async queue | static table + GPU-second actuals via `metrics.predict_time` |
| `genforge/adapters/openai` | sync | static table (`dall-e-3`, `tts-1`); variable models require `maxCost` |
| `genforge/adapters/fake` | either | scriptable — dry-run whole pipelines with zero spend |

Variable-cost providers reserve the worst case upfront and confirm the actual
on completion, releasing the difference back to your budget.

Writing an adapter is implementing one type:

```ts
type Adapter = {
  provider: string;
  model: string;
  price: (units, db) => Promise<{ usdPerUnit, unit, source } | null>;
  submit: (input) => Promise<{ kind: "done", output } | { kind: "job", jobId }>;
  poll?: (jobId) => Promise<{ status: "running" } | { status: "done", output }>;
};
```

## CLI

```
genforge dev        review UI (default :4321)
genforge ls         runs with status + spend
genforge gates      pending review gates
genforge verdict <gateId> keep|reject [note]
genforge spend      total ledger spend
```

## Development

```bash
bun install
bun test            # includes a real SIGKILL crash-resume integration test
bun run check       # ultracite (biome) lint
bun run typecheck
```

Conventional commits; releases via release-please. MIT.
