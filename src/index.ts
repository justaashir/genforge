// genforge — spend-aware durable steps for paid AI APIs.
// Three primitives: run() gives you a context, step() spends money durably,
// gate() blocks on a human verdict. One SQLite file, zero infra.

export { fakeAdapter } from "./adapters/fake";
export type {
  Adapter,
  PollResult,
  ProviderOutput,
  ResolvedPrice,
  SubmitResult,
} from "./adapters/types";
export type { Ctx } from "./context";
export { DEFAULT_DB_PATH, openDb } from "./db";
export {
  BudgetExceededError,
  GateRejectedError,
  GateTimeoutError,
  JobFailedError,
  PriceUnknownError,
} from "./errors";
export { type GateOptions, type GateVerdict, gate } from "./gate";
export type { GateRow, RunRow, StepRow } from "./ledger";
export {
  clearGate,
  getRun,
  getStep,
  listGates,
  listRuns,
  listSteps,
  runSpend,
  setGateVerdict,
  totalSpend,
} from "./ledger";
export { type RunHandle, type RunOptions, run } from "./run";
export { type StepOptions, type StepResult, step } from "./step";
