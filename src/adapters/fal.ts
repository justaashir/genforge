// fal.ai adapter — async queue provider with a LIVE pricing API (the only
// major provider that has one). Raw fetch on purpose: no SDK dependency,
// and the queue REST surface is tiny (submit / status / result).
import type { Database } from "bun:sqlite";
import { JobFailedError } from "../errors";
import type {
  Adapter,
  PollResult,
  ProviderOutput,
  ResolvedPrice,
  SubmitResult,
} from "./types";

export type FalOptions = {
  /** Defaults to process.env.FAL_KEY */
  apiKey?: string;
  /** Override for tests / proxies. Default https://queue.fal.run */
  queueBaseUrl?: string;
  /** Override for tests / proxies. Default https://api.fal.ai */
  apiBaseUrl?: string;
  /** Live-price cache TTL in ms. Default 24h. */
  priceTtlMs?: number;
};

const DEFAULT_QUEUE = "https://queue.fal.run";
const DEFAULT_API = "https://api.fal.ai";
const DEFAULT_TTL = 24 * 60 * 60 * 1000;

export function fal(model: string, opts: FalOptions = {}): Adapter {
  const queueBase = opts.queueBaseUrl ?? DEFAULT_QUEUE;
  const apiBase = opts.apiBaseUrl ?? DEFAULT_API;
  const ttl = opts.priceTtlMs ?? DEFAULT_TTL;

  const headers = () => {
    const key = opts.apiKey ?? process.env.FAL_KEY;
    if (!key) {
      throw new Error("fal adapter needs an apiKey (or FAL_KEY in env)");
    }
    return {
      Authorization: `Key ${key}`,
      "Content-Type": "application/json",
    };
  };

  // status/result live under owner/alias only — subpaths are dropped by fal
  const requestUrl = (jobId: string) => {
    const [owner, alias] = model.split("/");
    return `${queueBase}/${owner}/${alias}/requests/${jobId}`;
  };

  return {
    model,
    poll: async (jobId: string): Promise<PollResult> => {
      const statusRes = await fetch(`${requestUrl(jobId)}/status`, {
        headers: headers(),
      });
      if (statusRes.status === 404) {
        // unknown to the queue: expired or never existed — polling forever won't fix it
        throw new JobFailedError(
          jobId,
          "job not found or expired (status 404)"
        );
      }
      if (!statusRes.ok) {
        // auth/transport problems are transient from the ledger's view: the
        // job may still be running provider-side
        throw new Error(`fal status ${statusRes.status} for ${jobId}`);
      }
      const { status } = (await statusRes.json()) as { status?: string };
      if (status !== "COMPLETED") {
        return { status: "running" };
      }
      const res = await fetch(requestUrl(jobId), { headers: headers() });
      if (res.status === 422) {
        // COMPLETED + 422 = rejected at validation, never ran, not charged
        const detail = JSON.stringify(await res.json()).slice(0, 500);
        throw new JobFailedError(
          jobId,
          `validation error (not charged): ${detail}`
        );
      }
      if (!res.ok) {
        throw new Error(`fal result fetch ${res.status} for ${jobId}`);
      }
      const output = extractOutput(await res.json());
      if (!output) {
        throw new JobFailedError(jobId, "completed but no file in result");
      }
      return { output, status: "done" };
    },
    price: async (
      _units: number,
      db: Database
    ): Promise<ResolvedPrice | null> => {
      const cached = db
        .query(
          "SELECT unit, usd_per_unit, fetched_at FROM prices WHERE provider = 'fal' AND model = ?"
        )
        .get(model) as {
        unit: string;
        usd_per_unit: number;
        fetched_at: string;
      } | null;
      if (
        cached &&
        Date.now() - new Date(`${cached.fetched_at}Z`).getTime() < ttl
      ) {
        return {
          source: "live",
          unit: cached.unit,
          usdPerUnit: cached.usd_per_unit,
        };
      }

      const res = await fetch(
        `${apiBase}/v1/models/pricing?endpoint_id=${encodeURIComponent(model)}`,
        { headers: { Authorization: headers().Authorization } }
      );
      if (!res.ok) {
        return cached
          ? {
              source: "live",
              unit: cached.unit,
              usdPerUnit: cached.usd_per_unit,
            }
          : null;
      }
      const body = (await res.json()) as {
        prices?: Array<{
          endpoint_id: string;
          unit: string;
          unit_price: number;
        }>;
      };
      const price =
        body.prices?.find((p) => p.endpoint_id === model) ?? body.prices?.[0];
      if (!price) {
        return null;
      }
      db.query(
        `INSERT INTO prices (provider, model, unit, usd_per_unit, source, fetched_at)
         VALUES ('fal', ?, ?, ?, 'live', datetime('now'))
         ON CONFLICT(provider, model) DO UPDATE SET
           unit = excluded.unit, usd_per_unit = excluded.usd_per_unit,
           fetched_at = excluded.fetched_at`
      ).run(model, price.unit, price.unit_price);
      return { source: "live", unit: price.unit, usdPerUnit: price.unit_price };
    },
    provider: "fal",
    submit: async (input: unknown): Promise<SubmitResult> => {
      const res = await fetch(`${queueBase}/${model}`, {
        body: JSON.stringify(input),
        headers: headers(),
        method: "POST",
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 500);
        throw new Error(`fal submit ${res.status}: ${detail}`);
      }
      const body = (await res.json()) as { request_id: string };
      return { jobId: body.request_id, kind: "job" };
    },
  };
}

/** fal result payloads put the file under video/image/audio/file or images[]/videos[]. */
function extractOutput(data: unknown): ProviderOutput | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const record = data as Record<string, unknown>;
  for (const key of ["video", "image", "audio", "file"]) {
    const value = record[key] as
      | { url?: string; content_type?: string }
      | undefined;
    if (value?.url) {
      return { contentType: value.content_type, url: value.url };
    }
  }
  for (const key of ["images", "videos"]) {
    const arr = record[key] as
      | Array<{ url?: string; content_type?: string }>
      | undefined;
    if (Array.isArray(arr) && arr[0]?.url) {
      return { contentType: arr[0].content_type, url: arr[0].url };
    }
  }
  return null;
}
