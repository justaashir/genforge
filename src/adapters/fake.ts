import { JobFailedError } from "../errors";
import type { Adapter, PollResult, SubmitResult } from "./types";

export type FakeAdapterOptions = {
  /** null = price unknown (forces maxCost). Default 0.05. */
  usdPerUnit?: number | null;
  /** sync = submit returns output directly; async = queue + poll. Default sync. */
  mode?: "sync" | "async";
  /** async only: how many polls before the job reports done. Default 1. */
  pollsUntilDone?: number;
  /** first N submit calls throw (simulates provider/network failure). */
  failSubmitTimes?: number;
  /** first N poll calls throw a transient error (simulates crash mid-poll). */
  failPollTimes?: number;
  /** after transient failures: next N polls throw a terminal JobFailedError
   * (carries actualUsd as billed usage when set — like Replicate failures). */
  failPollTerminalTimes?: number;
  /** override the output url (e.g. an http url to exercise download). */
  outputUrl?: string;
  /** report this as the actual billed cost on completion (variable-cost providers). */
  actualUsd?: number;
  model?: string;
};

export type FakeAdapter = Adapter & {
  counters: { submits: number; polls: number };
};

/**
 * Scriptable in-memory adapter — shipped, not test-only, so users can dry-run
 * whole pipelines with zero spend before pointing them at a real provider.
 */
export function fakeAdapter(opts: FakeAdapterOptions = {}): FakeAdapter {
  const counters = { polls: 0, submits: 0 };
  const mode = opts.mode ?? "sync";
  const pollsUntilDone = opts.pollsUntilDone ?? 1;
  let submitFailures = opts.failSubmitTimes ?? 0;
  let pollFailures = opts.failPollTimes ?? 0;
  let pollTerminalFailures = opts.failPollTerminalTimes ?? 0;
  const usage = () =>
    opts.actualUsd === undefined ? undefined : { usdActual: opts.actualUsd };

  const output = (id: string) => ({
    contentType: "image/png",
    url: opts.outputUrl ?? `fake://output/${id}`,
  });

  const adapter: FakeAdapter = {
    counters,
    model: opts.model ?? "fake/model",
    price: () => {
      if (opts.usdPerUnit === null) {
        return Promise.resolve(null);
      }
      return Promise.resolve({
        source: "static" as const,
        unit: "unit",
        usdPerUnit: opts.usdPerUnit ?? 0.05,
      });
    },
    provider: "fake",
    submit: (): Promise<SubmitResult> => {
      counters.submits += 1; // counts attempts, including failed ones
      if (submitFailures > 0) {
        submitFailures -= 1;
        return Promise.reject(new Error("submit failed"));
      }
      if (mode === "sync") {
        return Promise.resolve({
          kind: "done" as const,
          output: output(String(counters.submits)),
          usage: usage(),
        });
      }
      return Promise.resolve({ jobId: `job-${counters.submits}`, kind: "job" });
    },
  };

  if (mode === "async") {
    adapter.poll = (jobId: string): Promise<PollResult> => {
      if (pollFailures > 0) {
        pollFailures -= 1;
        return Promise.reject(new Error("poll failed"));
      }
      if (pollTerminalFailures > 0) {
        pollTerminalFailures -= 1;
        return Promise.reject(
          new JobFailedError(jobId, "job failed terminally", usage())
        );
      }
      counters.polls += 1;
      if (counters.polls >= pollsUntilDone) {
        return Promise.resolve({
          output: output(jobId),
          status: "done" as const,
          usage: usage(),
        });
      }
      return Promise.resolve({ status: "running" });
    };
  }

  return adapter;
}
