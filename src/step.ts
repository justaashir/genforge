import type { ActualUsage, Adapter, ProviderOutput } from "./adapters/types";
import { saveArtifact } from "./artifact";
import type { Ctx } from "./context";
import {
  BudgetExceededError,
  JobFailedError,
  PriceUnknownError,
} from "./errors";
import { gate } from "./gate";
import {
  getRun,
  getStep,
  insertStep,
  markDone,
  markFailed,
  markSubmitted,
  runSpend,
  type StepRow,
  setArtifact,
} from "./ledger";

export type StepOptions = {
  adapter: Adapter;
  input: unknown;
  /** Billed units for the estimate (seconds, images, characters…). Default 1. */
  units?: number;
  /** Hard cap used as the estimate when no price is known. Required if price resolves null. */
  maxCost?: number;
  /** Estimates above this USD value block on an approval gate before submitting. */
  approveOver?: number;
  /** Download http(s)/data: outputs to artifactsDir. Default true. */
  download?: boolean;
};

export type StepResult = {
  url: string;
  path?: string;
  contentType?: string;
  /** Confirmed cost once the provider reports done; the reserved estimate before that. */
  costUsd: number;
  /** True when this call was answered from the ledger without touching the provider. */
  cached: boolean;
};

/**
 * One durable, priced provider call. Memoized by (runId, key): done steps
 * return from the ledger, in-flight async jobs re-attach by jobId, failed
 * steps re-run. Money is reserved before submit and confirmed or released
 * after. (The `approve:` gate-key prefix is reserved for approveOver gates —
 * don't reuse it for your own gate() keys.)
 */
export async function step(
  ctx: Ctx,
  key: string,
  opts: StepOptions
): Promise<StepResult> {
  const { db } = ctx;
  const existing = getStep(db, ctx.runId, key);
  if (existing?.status === "done") {
    return await replay(ctx, existing, opts);
  }

  // crash-safe resume: submitted + jobId → re-attach, never resubmit.
  // No pricing here — the money was already committed at existing.est_usd.
  if (
    existing?.status === "submitted" &&
    existing.provider_job_id &&
    opts.adapter.poll
  ) {
    return await attach(ctx, existing, existing.provider_job_id, opts);
  }

  const estUsd = await resolveEstimate(ctx, key, opts);
  enforceBudget(ctx, key, estUsd);

  if (opts.approveOver !== undefined && estUsd > opts.approveOver) {
    await gate(ctx, `approve:${key}`, {
      evidence: { estUsd, model: opts.adapter.model, step: key },
      note: `est. $${estUsd.toFixed(2)} exceeds the $${opts.approveOver.toFixed(2)} approval threshold`,
    });
    // the wait may have lasted hours — whatever spent meanwhile counts again
    enforceBudget(ctx, key, estUsd);
  }

  const stepId = insertStep(db, {
    estUsd,
    inputJson: JSON.stringify(opts.input ?? null),
    key,
    model: opts.adapter.model,
    provider: opts.adapter.provider,
    runId: ctx.runId,
    units: opts.units ?? 1,
  });

  try {
    const submitted = await opts.adapter.submit(opts.input);
    if (submitted.kind === "done") {
      return await settle(
        ctx,
        stepId,
        estUsd,
        opts,
        submitted.output,
        submitted.usage
      );
    }
    markSubmitted(db, stepId, submitted.jobId);
    if (!opts.adapter.poll) {
      throw new Error(
        `adapter ${opts.adapter.provider} returned a job but implements no poll()`
      );
    }
    const done = await pollUntilDone(ctx, opts.adapter, submitted.jobId);
    return await settle(ctx, stepId, estUsd, opts, done.output, done.usage);
  } catch (err) {
    // submit failures release the reservation; transient poll failures stay
    // 'submitted' (the job may still finish provider-side — resumable, still
    // reserved). A step already marked done keeps its money truth: an artifact
    // download error after that is retried free on the next run.
    const row = getStep(db, ctx.runId, key);
    if (
      row &&
      row.status !== "done" &&
      (row.status === "pending" || err instanceof JobFailedError)
    ) {
      markFailed(db, row.id, String(err), failureCost(err));
    }
    throw err;
  }
}

/** Terminal job failures can still have billed (Replicate charges GPU time). */
function failureCost(err: unknown): number | undefined {
  return err instanceof JobFailedError ? err.usage?.usdActual : undefined;
}

/**
 * A done step answered from the ledger. If the artifact was never downloaded
 * (download:false earlier, or a failed download after the money was recorded),
 * this call's download preference gets one more chance — for free.
 */
async function replay(
  ctx: Ctx,
  row: StepRow,
  opts: StepOptions
): Promise<StepResult> {
  const wantDownload = opts.download ?? true;
  if (wantDownload && !row.artifact_path && row.artifact_url) {
    const saved = await saveArtifact(
      row.artifact_url,
      ctx.artifactsDir,
      row.id,
      row.content_type ?? undefined
    );
    if (saved.path) {
      setArtifact(ctx.db, row.id, saved.path, saved.contentType);
      return fromRow(
        {
          ...row,
          artifact_path: saved.path,
          content_type: saved.contentType ?? row.content_type,
        },
        true
      );
    }
  }
  return fromRow(row, true);
}

/** Resume an in-flight job by its provider jobId — never a second submit. */
async function attach(
  ctx: Ctx,
  row: StepRow,
  jobId: string,
  opts: StepOptions
): Promise<StepResult> {
  try {
    const done = await pollUntilDone(ctx, opts.adapter, jobId);
    return await settle(
      ctx,
      row.id,
      row.est_usd,
      opts,
      done.output,
      done.usage
    );
  } catch (err) {
    // terminal provider failure → failed (re-runnable, reservation released);
    // anything else is transient — stay 'submitted' and resumable
    if (err instanceof JobFailedError) {
      markFailed(ctx.db, row.id, String(err), err.usage?.usdActual);
    }
    throw err;
  }
}

async function resolveEstimate(
  ctx: Ctx,
  key: string,
  opts: StepOptions
): Promise<number> {
  const units = opts.units ?? 1;
  const price = await opts.adapter.price(units, ctx.db);
  if (price) {
    return price.usdPerUnit * units;
  }
  if (opts.maxCost !== undefined) {
    return opts.maxCost;
  }
  throw new PriceUnknownError(key, opts.adapter.model);
}

function enforceBudget(ctx: Ctx, key: string, estUsd: number): void {
  const budgetUsd = getRun(ctx.db, ctx.runId)?.budget_usd;
  if (budgetUsd === null || budgetUsd === undefined) {
    return;
  }
  const spent = runSpend(ctx.db, ctx.runId);
  if (spent + estUsd > budgetUsd) {
    throw new BudgetExceededError(key, estUsd, spent, budgetUsd);
  }
}

async function pollUntilDone(
  ctx: Ctx,
  adapter: Adapter,
  jobId: string
): Promise<{ output: ProviderOutput; usage?: ActualUsage }> {
  if (!adapter.poll) {
    throw new Error(`adapter ${adapter.provider} implements no poll()`);
  }
  for (;;) {
    const result = await adapter.poll(jobId);
    if (result.status === "done") {
      return { output: result.output, usage: result.usage };
    }
    await Bun.sleep(ctx.pollIntervalMs);
  }
}

async function settle(
  ctx: Ctx,
  stepId: number,
  estUsd: number,
  opts: StepOptions,
  output: ProviderOutput,
  usage?: ActualUsage
): Promise<StepResult> {
  // money truth first: the provider has billed by now, so the confirmed cost
  // is recorded BEFORE any download can fail. Variable-cost providers report
  // actuals; fixed-price units confirm at the estimate. Either way the
  // reservation is fully released here.
  const costUsd = usage?.usdActual ?? estUsd;
  markDone(ctx.db, stepId, {
    artifactUrl: output.url,
    contentType: output.contentType ?? null,
    costUsd,
  });

  if (!(opts.download ?? true)) {
    return {
      cached: false,
      contentType: output.contentType,
      costUsd,
      url: output.url,
    };
  }

  const saved = await saveArtifact(
    output.url,
    ctx.artifactsDir,
    stepId,
    output.contentType
  );
  const contentType = saved.contentType ?? output.contentType ?? null;
  setArtifact(ctx.db, stepId, saved.path, contentType);
  return {
    cached: false,
    contentType: contentType ?? undefined,
    costUsd,
    path: saved.path ?? undefined,
    url: output.url,
  };
}

function fromRow(row: StepRow, cached: boolean): StepResult {
  return {
    cached,
    contentType: row.content_type ?? undefined,
    costUsd: row.cost_usd ?? row.est_usd,
    path: row.artifact_path ?? undefined,
    url: row.artifact_url ?? "",
  };
}
