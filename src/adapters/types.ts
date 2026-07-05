import type { Database } from "bun:sqlite";

/** A file-like output from a provider. `url` may be http(s), data:, or provider-internal. */
export type ProviderOutput = {
  url: string;
  contentType?: string;
};

export type SubmitResult =
  /** Sync providers (OpenAI images/TTS): the call either landed or it didn't. */
  | { kind: "done"; output: ProviderOutput }
  /** Async queue providers (fal, Replicate): jobId is the crash-safe resume handle. */
  | { kind: "job"; jobId: string };

export type PollResult =
  | { status: "running" }
  | { status: "done"; output: ProviderOutput };

export type ResolvedPrice = {
  usdPerUnit: number;
  unit: string;
  source: "live" | "static";
};

/**
 * The only abstraction in the library. Absorbs all provider heterogeneity:
 * billing units, live vs static pricing, sync vs async job models.
 */
export type Adapter = {
  provider: string;
  model: string;
  /** Resolve the price per unit, or null if genuinely unknown (step then requires maxCost). */
  price: (units: number, db: Database) => Promise<ResolvedPrice | null>;
  submit: (input: unknown) => Promise<SubmitResult>;
  /**
   * Required for adapters that return jobs. Throw JobFailedError for terminal
   * provider-side failures; any other throw is treated as transient (resumable).
   */
  poll?: (jobId: string) => Promise<PollResult>;
};
