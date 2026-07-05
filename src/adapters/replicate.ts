// Replicate adapter — async predictions API, no pricing endpoint. Prices come
// from the shipped static table; unknown models force an explicit maxCost.
// Community models bill actual GPU time: when the prediction reports
// metrics.predict_time and a per-second rate is known, actual cost is
// confirmed instead of the estimate.
import { JobFailedError } from "../errors";
import { staticPrice } from "../prices";
import type {
  Adapter,
  PollResult,
  ProviderOutput,
  SubmitResult,
} from "./types";

export type ReplicateOptions = {
  /** Defaults to process.env.REPLICATE_API_TOKEN */
  apiKey?: string;
  /** Override for tests / proxies. Default https://api.replicate.com */
  baseUrl?: string;
  /**
   * USD per GPU-second for hardware-billed community models. When set, actual
   * cost = predict_time × this rate (reported as usage on completion).
   */
  usdPerGpuSecond?: number;
};

const DEFAULT_BASE = "https://api.replicate.com";
const TERMINAL_FAILURES = new Set(["failed", "canceled"]);

type Prediction = {
  id: string;
  status: string;
  output?: unknown;
  error?: string | null;
  metrics?: { predict_time?: number };
};

export function replicate(model: string, opts: ReplicateOptions = {}): Adapter {
  const base = opts.baseUrl ?? DEFAULT_BASE;

  const headers = () => {
    const key = opts.apiKey ?? process.env.REPLICATE_API_TOKEN;
    if (!key) {
      throw new Error(
        "replicate adapter needs an apiKey (or REPLICATE_API_TOKEN in env)"
      );
    }
    return {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    };
  };

  return {
    model,
    poll: async (jobId: string): Promise<PollResult> => {
      const res = await fetch(`${base}/v1/predictions/${jobId}`, {
        headers: headers(),
      });
      if (!res.ok) {
        throw new Error(`replicate poll ${res.status} for ${jobId}`);
      }
      const prediction = (await res.json()) as Prediction;
      if (TERMINAL_FAILURES.has(prediction.status)) {
        throw new JobFailedError(
          jobId,
          prediction.error ?? `status ${prediction.status}`
        );
      }
      if (prediction.status !== "succeeded") {
        return { status: "running" };
      }
      const output = extractOutput(prediction.output);
      if (!output) {
        throw new JobFailedError(jobId, "succeeded but no output url");
      }
      const predictTime = prediction.metrics?.predict_time;
      const usage =
        predictTime !== undefined && opts.usdPerGpuSecond !== undefined
          ? {
              units: predictTime,
              usdActual: predictTime * opts.usdPerGpuSecond,
            }
          : undefined;
      return { output, status: "done", usage };
    },
    price: (_units, _db) => Promise.resolve(staticPrice("replicate", model)),
    provider: "replicate",
    submit: async (input: unknown): Promise<SubmitResult> => {
      const res = await fetch(`${base}/v1/models/${model}/predictions`, {
        body: JSON.stringify({ input }),
        headers: headers(),
        method: "POST",
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 500);
        throw new Error(`replicate submit ${res.status}: ${detail}`);
      }
      const prediction = (await res.json()) as Prediction;
      return { jobId: prediction.id, kind: "job" };
    },
  };
}

/** Replicate output is a url string, an array of url strings, or an object with a url. */
function extractOutput(output: unknown): ProviderOutput | null {
  if (typeof output === "string" && output.length > 0) {
    return { url: output };
  }
  if (Array.isArray(output) && typeof output[0] === "string") {
    return { url: output[0] };
  }
  if (
    output &&
    typeof output === "object" &&
    typeof (output as { url?: unknown }).url === "string"
  ) {
    return { url: (output as { url: string }).url };
  }
  return null;
}
