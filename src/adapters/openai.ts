// OpenAI images adapter — the sync-provider proof: one request, no queue, no
// jobId. The call either landed (and was billed) or it didn't. gpt-image-1
// returns base64; the artifact layer persists it via a data: url.
import { staticPrice } from "../prices";
import type { Adapter, SubmitResult } from "./types";

export type OpenAiImageOptions = {
  /** Defaults to process.env.OPENAI_API_KEY */
  apiKey?: string;
  /** Override for tests / proxies. Default https://api.openai.com */
  baseUrl?: string;
};

const DEFAULT_BASE = "https://api.openai.com";

type ImageResponse = {
  data?: Array<{ url?: string; b64_json?: string }>;
};

export function openaiImage(
  model: string,
  opts: OpenAiImageOptions = {}
): Adapter {
  const base = opts.baseUrl ?? DEFAULT_BASE;

  return {
    model,
    price: (_units, _db) => Promise.resolve(staticPrice("openai", model)),
    provider: "openai",
    submit: async (input: unknown): Promise<SubmitResult> => {
      const key = opts.apiKey ?? process.env.OPENAI_API_KEY;
      if (!key) {
        throw new Error(
          "openai adapter needs an apiKey (or OPENAI_API_KEY in env)"
        );
      }
      const res = await fetch(`${base}/v1/images/generations`, {
        // model last: pricing was resolved for THIS model, input can't override it
        body: JSON.stringify({ ...(input as Record<string, unknown>), model }),
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 500);
        throw new Error(`openai submit ${res.status}: ${detail}`);
      }
      const body = (await res.json()) as ImageResponse;
      const image = body.data?.[0];
      if (image?.url) {
        return { kind: "done", output: { url: image.url } };
      }
      if (image?.b64_json) {
        return {
          kind: "done",
          output: {
            contentType: "image/png",
            url: `data:image/png;base64,${image.b64_json}`,
          },
        };
      }
      throw new Error("openai response contained no image");
    },
  };
}
