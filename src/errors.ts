/** Step estimate would push the run past its budget ceiling. Nothing was submitted. */
export class BudgetExceededError extends Error {
  constructor(
    readonly stepKey: string,
    readonly estUsd: number,
    readonly spentUsd: number,
    readonly budgetUsd: number
  ) {
    super(
      `step '${stepKey}' est. $${estUsd.toFixed(4)} would exceed budget: ` +
        `$${spentUsd.toFixed(4)} spent of $${budgetUsd.toFixed(2)} ceiling`
    );
    this.name = "BudgetExceededError";
  }
}

/** No price could be resolved and the step declared no maxCost. Nothing was submitted. */
export class PriceUnknownError extends Error {
  constructor(
    readonly stepKey: string,
    readonly model: string
  ) {
    super(
      `no price known for '${model}' and step '${stepKey}' declares no maxCost — ` +
        "unknown price is never treated as free; pass maxCost to proceed"
    );
    this.name = "PriceUnknownError";
  }
}

/** A human rejected this gate. The run stops here. */
export class GateRejectedError extends Error {
  constructor(
    readonly gateKey: string,
    readonly note?: string
  ) {
    super(`gate '${gateKey}' rejected${note ? `: ${note}` : ""}`);
    this.name = "GateRejectedError";
  }
}

/** Gate wait exceeded timeoutMs. The gate stays pending — never auto-approved. */
export class GateTimeoutError extends Error {
  constructor(readonly gateKey: string) {
    super(`gate '${gateKey}' timed out waiting for a verdict (still pending)`);
    this.name = "GateTimeoutError";
  }
}

/** The provider reported the job itself failed (terminal, not a transient poll error). */
export class JobFailedError extends Error {
  constructor(
    readonly jobId: string,
    detail: string
  ) {
    super(`provider job ${jobId} failed: ${detail}`);
    this.name = "JobFailedError";
  }
}
