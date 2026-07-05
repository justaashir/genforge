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
  estUsd: number;
  /** True when this call was answered from the ledger without touching the provider. */
  cached: boolean;
};

/**
 * One durable, priced provider call. Memoized by (runId, key): done steps
 * return from the ledger, in-flight async jobs re-attach by jobId, failed
 * steps re-run. Money is reserved before submit and confirmed or released after.
 */
export async function step(
  ctx: Ctx,
  key: string,
  opts: StepOptions
): Promise<StepResult> {
  const { db } = ctx;
  const existing = getStep(db, ctx.runId, key);
  if (existing?.status === "done") {
    return fromRow(existing, true);
  }

  const estUsd = await resolveEstimate(ctx, key, opts);

  // crash-safe resume: submitted + jobId → re-attach, never resubmit
  if (
    existing?.status === "submitted" &&
    existing.provider_job_id &&
    opts.adapter.poll
  ) {
    const done = await pollUntilDone(
      ctx,
      opts.adapter,
      existing.provider_job_id
    );
    return await settle(
      ctx,
      existing.id,
      estUsd,
      opts,
      done.output,
      done.usage
    );
  }

  enforceBudget(ctx, key, estUsd);

  if (opts.approveOver !== undefined && estUsd > opts.approveOver) {
    await gate(ctx, `approve:${key}`, {
      evidence: { estUsd, model: opts.adapter.model, step: key },
      note: `est. $${estUsd.toFixed(2)} exceeds the $${opts.approveOver.toFixed(2)} approval threshold`,
    });
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
    // submit failures release the reservation; poll failures stay 'submitted'
    // (the job may still finish provider-side — resumable, still reserved)
    const row = getStep(db, ctx.runId, key);
    if (row && (row.status === "pending" || err instanceof JobFailedError)) {
      markFailed(db, row.id, String(err));
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
  const wantDownload = opts.download ?? true;
  const saved = wantDownload
    ? await saveArtifact(
        output.url,
        ctx.artifactsDir,
        stepId,
        output.contentType
      )
    : { contentType: output.contentType ?? null, path: null };

  // variable-cost providers report actuals; fixed-price units confirm at the
  // estimate. Either way the reservation is fully released here.
  const costUsd = usage?.usdActual ?? estUsd;
  markDone(ctx.db, stepId, {
    artifactPath: saved.path,
    artifactUrl: output.url,
    contentType: saved.contentType,
    costUsd,
  });

  return {
    cached: false,
    contentType: saved.contentType ?? undefined,
    estUsd: costUsd,
    path: saved.path ?? undefined,
    url: output.url,
  };
}

function fromRow(row: StepRow, cached: boolean): StepResult {
  return {
    cached,
    contentType: row.content_type ?? undefined,
    estUsd: row.cost_usd ?? row.est_usd,
    path: row.artifact_path ?? undefined,
    url: row.artifact_url ?? "",
  };
}
