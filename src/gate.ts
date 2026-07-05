import type { Ctx } from "./context";
import { GateRejectedError, GateTimeoutError } from "./errors";
import { getGate, insertGate } from "./ledger";

export type GateOptions = {
  /** Artifact of a prior step to show the reviewer. */
  artifact?: { url: string; path?: string | null };
  /** One-line context for the reviewer. */
  note?: string;
  /** Extra evidence-pack fields (cost, model, anything the reviewer needs). */
  evidence?: Record<string, unknown>;
  /** Throw GateTimeoutError after this long. Never auto-approves. */
  timeoutMs?: number;
};

export type GateVerdict = { verdict: "keep"; note?: string };

/**
 * Block the run until a human writes a verdict (via the review UI or CLI).
 * keep → returns. reject → throws GateRejectedError. Verdicts are sticky:
 * a decided gate resolves instantly on resume.
 */
export async function gate(
  ctx: Ctx,
  key: string,
  opts: GateOptions = {}
): Promise<GateVerdict> {
  const existing = getGate(ctx.db, ctx.runId, key);
  if (!existing?.verdict) {
    insertGate(
      ctx.db,
      ctx.runId,
      key,
      JSON.stringify({
        artifact: opts.artifact ?? null,
        note: opts.note ?? null,
        workflow: ctx.workflow,
        ...opts.evidence,
      })
    );
  }

  const deadline =
    opts.timeoutMs === undefined ? null : Date.now() + opts.timeoutMs;

  for (;;) {
    const row = getGate(ctx.db, ctx.runId, key);
    if (row?.verdict === "keep") {
      return { note: row.note ?? undefined, verdict: "keep" };
    }
    if (row?.verdict === "reject") {
      throw new GateRejectedError(key, row.note ?? undefined);
    }
    if (deadline !== null && Date.now() > deadline) {
      throw new GateTimeoutError(key);
    }
    await Bun.sleep(ctx.pollIntervalMs);
  }
}
