import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { openDb } from "../db";
import { JobFailedError } from "../errors";
import { fal } from "./fal";
import { openaiImage } from "./openai";
import { replicate } from "./replicate";

// ---------------------------------------------------------------------------
// mock fal: queue submit → status (queued, then completed) → result + pricing
// ---------------------------------------------------------------------------
function mockFalServer() {
  let statusCalls = 0;
  const server = Bun.serve({
    fetch: (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/v1/models/pricing") {
        return Response.json({
          prices: [
            {
              endpoint_id: url.searchParams.get("endpoint_id"),
              unit: "seconds",
              unit_price: 0.112,
            },
          ],
        });
      }
      if (url.pathname.endsWith("/status")) {
        statusCalls += 1;
        return Response.json({
          status: statusCalls < 2 ? "IN_PROGRESS" : "COMPLETED",
        });
      }
      if (url.pathname.includes("/requests/")) {
        return Response.json({
          video: {
            content_type: "video/mp4",
            url: "https://cdn.example/v.mp4",
          },
        });
      }
      if (req.method === "POST") {
        return Response.json({ request_id: "req-123" });
      }
      return new Response("not found", { status: 404 });
    },
    port: 0,
  });
  return server;
}

describe("fal adapter contract", () => {
  const server = mockFalServer();
  const base = `http://localhost:${server.port}`;
  const adapter = fal("fal-ai/kling-video/v3/pro/image-to-video", {
    apiBaseUrl: base,
    apiKey: "test-key",
    queueBaseUrl: base,
  });
  afterAll(() => server.stop(true));

  test("live price is fetched and cached in the db", async () => {
    const db = openDb(new Database(":memory:"));
    const price = await adapter.price(15, db);
    expect(price?.usdPerUnit).toBe(0.112);
    expect(price?.source).toBe("live");
    const cached = db
      .query("SELECT usd_per_unit FROM prices WHERE provider = 'fal'")
      .get() as { usd_per_unit: number };
    expect(cached.usd_per_unit).toBe(0.112);
  });

  test("submit returns the queue request_id as jobId", async () => {
    const result = await adapter.submit({ prompt: "x" });
    expect(result).toEqual({ jobId: "req-123", kind: "job" });
  });

  test("poll reports running until COMPLETED, then extracts the file", async () => {
    const first = await adapter.poll?.("req-123");
    expect(first?.status).toBe("running");
    const second = await adapter.poll?.("req-123");
    expect(second?.status).toBe("done");
    if (second?.status === "done") {
      expect(second.output.url).toBe("https://cdn.example/v.mp4");
      expect(second.output.contentType).toBe("video/mp4");
    }
  });
});

describe("fal adapter — terminal validation failure", () => {
  test("COMPLETED + 422 result throws JobFailedError (not charged)", async () => {
    const server = Bun.serve({
      fetch: (req) => {
        const url = new URL(req.url);
        if (url.pathname.endsWith("/status")) {
          return Response.json({ status: "COMPLETED" });
        }
        return Response.json(
          { detail: "end_image_url not allowed with multi_prompt" },
          { status: 422 }
        );
      },
      port: 0,
    });
    const base = `http://localhost:${server.port}`;
    const adapter = fal("fal-ai/kling-video/v3/pro/image-to-video", {
      apiBaseUrl: base,
      apiKey: "test-key",
      queueBaseUrl: base,
    });
    try {
      await expect(adapter.poll?.("bad-job")).rejects.toThrow(JobFailedError);
    } finally {
      server.stop(true);
    }
  });
});

// ---------------------------------------------------------------------------
// mock replicate: predictions create → processing → succeeded with metrics
// ---------------------------------------------------------------------------
describe("replicate adapter contract", () => {
  let polls = 0;
  const server = Bun.serve({
    fetch: (req) => {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname.endsWith("/predictions")) {
        return Response.json({ id: "pred-9", status: "starting" });
      }
      if (url.pathname === "/v1/predictions/pred-9") {
        polls += 1;
        if (polls < 2) {
          return Response.json({ id: "pred-9", status: "processing" });
        }
        return Response.json({
          id: "pred-9",
          metrics: { predict_time: 8.2 },
          output: ["https://replicate.delivery/out.png"],
          status: "succeeded",
        });
      }
      if (url.pathname === "/v1/predictions/pred-dead") {
        return Response.json({
          error: "CUDA out of memory",
          id: "pred-dead",
          status: "failed",
        });
      }
      return new Response("not found", { status: 404 });
    },
    port: 0,
  });
  const base = `http://localhost:${server.port}`;
  afterAll(() => server.stop(true));

  test("submit → poll → succeeded, with GPU-second actuals reported", async () => {
    const adapter = replicate("black-forest-labs/flux-dev", {
      apiKey: "test-token",
      baseUrl: base,
      usdPerGpuSecond: 0.000_725,
    });
    const submitted = await adapter.submit({ prompt: "x" });
    expect(submitted).toEqual({ jobId: "pred-9", kind: "job" });

    const first = await adapter.poll?.("pred-9");
    expect(first?.status).toBe("running");
    const second = await adapter.poll?.("pred-9");
    expect(second?.status).toBe("done");
    if (second?.status === "done") {
      expect(second.output.url).toBe("https://replicate.delivery/out.png");
      expect(second.usage?.usdActual).toBeCloseTo(8.2 * 0.000_725);
    }
  });

  test("failed prediction throws JobFailedError with the provider error", async () => {
    const adapter = replicate("black-forest-labs/flux-dev", {
      apiKey: "test-token",
      baseUrl: base,
    });
    await expect(adapter.poll?.("pred-dead")).rejects.toThrow(
      "CUDA out of memory"
    );
  });

  test("known model resolves a static price; unknown model resolves null", async () => {
    const db = new Database(":memory:");
    const known = replicate("black-forest-labs/flux-dev", { baseUrl: base });
    expect((await known.price(1, db))?.usdPerUnit).toBe(0.025);
    const unknown = replicate("someone/brand-new-model", { baseUrl: base });
    expect(await unknown.price(1, db)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// mock openai: sync images endpoint, b64 and url variants
// ---------------------------------------------------------------------------
describe("openai adapter contract (sync provider)", () => {
  const server = Bun.serve({
    fetch: async (req) => {
      const body = (await req.json()) as { model?: string };
      if (body.model === "gpt-image-1") {
        return Response.json({ data: [{ b64_json: btoa("png-bytes") }] });
      }
      return Response.json({
        data: [{ url: "https://oai.example/img.png" }],
      });
    },
    port: 0,
  });
  const base = `http://localhost:${server.port}`;
  afterAll(() => server.stop(true));

  test("url response completes synchronously — no jobId, no poll", async () => {
    const adapter = openaiImage("dall-e-3", {
      apiKey: "sk-test",
      baseUrl: base,
    });
    expect(adapter.poll).toBeUndefined();
    const result = await adapter.submit({ prompt: "x", size: "1024x1024" });
    expect(result.kind).toBe("done");
    if (result.kind === "done") {
      expect(result.output.url).toBe("https://oai.example/img.png");
    }
  });

  test("b64 response becomes a data: url the artifact layer can persist", async () => {
    const adapter = openaiImage("gpt-image-1", {
      apiKey: "sk-test",
      baseUrl: base,
    });
    const result = await adapter.submit({ prompt: "x" });
    if (result.kind === "done") {
      expect(result.output.url).toStartWith("data:image/png;base64,");
    }
  });

  test("dall-e-3 has a static price; gpt-image-1 (variable) resolves null", async () => {
    const db = new Database(":memory:");
    const priced = openaiImage("dall-e-3", { baseUrl: base });
    expect((await priced.price(1, db))?.usdPerUnit).toBe(0.04);
    const variable = openaiImage("gpt-image-1", { baseUrl: base });
    expect(await variable.price(1, db)).toBeNull();
  });
});
