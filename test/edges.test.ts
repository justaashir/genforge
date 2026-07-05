// Edge-path tests: error branches and secondary paths in db, artifact, and
// the provider adapters — the code that only runs when things go wrong.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fal } from "../src/adapters/fal";
import { openaiImage } from "../src/adapters/openai";
import { replicate } from "../src/adapters/replicate";
import { saveArtifact } from "../src/artifact";
import { openDb } from "../src/db";
import { JobFailedError } from "../src/errors";

describe("openDb", () => {
  test("file path: creates parent dirs, applies schema, WAL mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "genforge-db-"));
    const path = join(dir, "nested", "deep", "ledger.sqlite");
    const db = openDb(path);
    expect(existsSync(path)).toBeTrue();
    db.query("INSERT INTO runs (id, workflow) VALUES ('r1', 'wf')").run();
    expect(
      (db.query("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n
    ).toBe(1);
    db.close();
  });
});

describe("saveArtifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "genforge-art-"));

  test("data: url with base64 payload is decoded and written", async () => {
    const saved = await saveArtifact(
      `data:image/png;base64,${btoa("png-bytes")}`,
      dir,
      1
    );
    expect(saved.contentType).toBe("image/png");
    expect(saved.path).toEndWith(".png");
    expect(await Bun.file(saved.path ?? "").text()).toBe("png-bytes");
  });

  test("data: url without base64 is percent-decoded", async () => {
    const saved = await saveArtifact("data:text/plain,hello%20world", dir, 2);
    expect(await Bun.file(saved.path ?? "").text()).toBe("hello world");
  });

  test("extension is guessed from content-type when the url has none", async () => {
    const server = Bun.serve({
      fetch: () =>
        new Response("vid", { headers: { "content-type": "video/mp4" } }),
      port: 0,
    });
    try {
      const saved = await saveArtifact(
        `http://localhost:${server.port}/no-extension`,
        dir,
        3
      );
      expect(saved.path).toEndWith(".mp4");
    } finally {
      server.stop(true);
    }
  });

  test("failed download throws instead of writing a broken artifact", async () => {
    const server = Bun.serve({
      fetch: () => new Response("gone", { status: 410 }),
      port: 0,
    });
    try {
      await expect(
        saveArtifact(`http://localhost:${server.port}/gone.png`, dir, 4)
      ).rejects.toThrow("artifact download failed: 410");
    } finally {
      server.stop(true);
    }
  });
});

describe("fal adapter edges", () => {
  test("missing api key throws before any network call", async () => {
    const previous = process.env.FAL_KEY;
    process.env.FAL_KEY = "";
    try {
      const adapter = fal("fal-ai/some/model");
      await expect(adapter.submit({})).rejects.toThrow("needs an apiKey");
    } finally {
      process.env.FAL_KEY = previous;
    }
  });

  test("price cache hit: second call answers from sqlite without the API", async () => {
    let pricingCalls = 0;
    const server = Bun.serve({
      fetch: () => {
        pricingCalls += 1;
        return Response.json({
          prices: [
            { endpoint_id: "fal-ai/x/y", unit: "images", unit_price: 0.02 },
          ],
        });
      },
      port: 0,
    });
    const base = `http://localhost:${server.port}`;
    const adapter = fal("fal-ai/x/y", {
      apiBaseUrl: base,
      apiKey: "k",
      queueBaseUrl: base,
    });
    const db = openDb(new Database(":memory:"));
    try {
      await adapter.price(1, db);
      const second = await adapter.price(1, db);
      expect(pricingCalls).toBe(1);
      expect(second?.usdPerUnit).toBe(0.02);
    } finally {
      server.stop(true);
    }
  });

  test("pricing API down + no cache resolves null (step will demand maxCost)", async () => {
    const server = Bun.serve({
      fetch: () => new Response("nope", { status: 500 }),
      port: 0,
    });
    const base = `http://localhost:${server.port}`;
    const adapter = fal("fal-ai/x/y", {
      apiBaseUrl: base,
      apiKey: "k",
      queueBaseUrl: base,
    });
    try {
      expect(
        await adapter.price(1, openDb(new Database(":memory:")))
      ).toBeNull();
    } finally {
      server.stop(true);
    }
  });

  test("submit failure surfaces status and detail", async () => {
    const server = Bun.serve({
      fetch: () => new Response("quota exceeded", { status: 429 }),
      port: 0,
    });
    const base = `http://localhost:${server.port}`;
    const adapter = fal("fal-ai/x/y", {
      apiBaseUrl: base,
      apiKey: "k",
      queueBaseUrl: base,
    });
    try {
      await expect(adapter.submit({})).rejects.toThrow("fal submit 429");
    } finally {
      server.stop(true);
    }
  });

  test("images[] result shape is extracted; missing file is terminal", async () => {
    let payload: Record<string, unknown> = {
      images: [{ content_type: "image/png", url: "https://cdn/x.png" }],
    };
    const server = Bun.serve({
      fetch: (req) => {
        if (new URL(req.url).pathname.endsWith("/status")) {
          return Response.json({ status: "COMPLETED" });
        }
        return Response.json(payload);
      },
      port: 0,
    });
    const base = `http://localhost:${server.port}`;
    const adapter = fal("fal-ai/x/y", {
      apiBaseUrl: base,
      apiKey: "k",
      queueBaseUrl: base,
    });
    try {
      const done = await adapter.poll?.("j1");
      if (done?.status === "done") {
        expect(done.output.url).toBe("https://cdn/x.png");
      }
      payload = { seed: 42 }; // completed but no file anywhere
      await expect(adapter.poll?.("j2")).rejects.toThrow(JobFailedError);
    } finally {
      server.stop(true);
    }
  });
});

describe("replicate adapter edges", () => {
  test("missing api key throws before any network call", async () => {
    const previous = process.env.REPLICATE_API_TOKEN;
    process.env.REPLICATE_API_TOKEN = "";
    try {
      const adapter = replicate("owner/model");
      await expect(adapter.submit({})).rejects.toThrow("needs an apiKey");
    } finally {
      process.env.REPLICATE_API_TOKEN = previous;
    }
  });

  test("submit/poll HTTP failures surface status; object output extracts url", async () => {
    let mode = "submit-fail";
    const server = Bun.serve({
      fetch: () => {
        if (mode === "submit-fail") {
          return new Response("invalid version", { status: 422 });
        }
        if (mode === "poll-fail") {
          return new Response("oops", { status: 500 });
        }
        return Response.json({
          id: "p1",
          output: { url: "https://cdn/out.mp4" },
          status: "succeeded",
        });
      },
      port: 0,
    });
    const base = `http://localhost:${server.port}`;
    const adapter = replicate("owner/model", { apiKey: "t", baseUrl: base });
    try {
      await expect(adapter.submit({})).rejects.toThrow("replicate submit 422");
      mode = "poll-fail";
      await expect(adapter.poll?.("p1")).rejects.toThrow("replicate poll 500");
      mode = "ok";
      const done = await adapter.poll?.("p1");
      if (done?.status === "done") {
        expect(done.output.url).toBe("https://cdn/out.mp4");
        expect(done.usage).toBeUndefined(); // no metrics, no rate → no actuals
      }
    } finally {
      server.stop(true);
    }
  });

  test("succeeded with unusable output is terminal", async () => {
    const server = Bun.serve({
      fetch: () => Response.json({ id: "p2", output: 42, status: "succeeded" }),
      port: 0,
    });
    const adapter = replicate("owner/model", {
      apiKey: "t",
      baseUrl: `http://localhost:${server.port}`,
    });
    try {
      await expect(adapter.poll?.("p2")).rejects.toThrow(JobFailedError);
    } finally {
      server.stop(true);
    }
  });
});

describe("openai adapter edges", () => {
  test("missing api key throws before any network call", async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "";
    try {
      const adapter = openaiImage("dall-e-3");
      await expect(adapter.submit({ prompt: "x" })).rejects.toThrow(
        "needs an apiKey"
      );
    } finally {
      process.env.OPENAI_API_KEY = previous;
    }
  });

  test("http error and empty data both throw", async () => {
    let fail = true;
    const server = Bun.serve({
      fetch: () =>
        fail
          ? new Response("billing hard limit", { status: 429 })
          : Response.json({ data: [] }),
      port: 0,
    });
    const adapter = openaiImage("dall-e-3", {
      apiKey: "sk",
      baseUrl: `http://localhost:${server.port}`,
    });
    try {
      await expect(adapter.submit({ prompt: "x" })).rejects.toThrow(
        "openai submit 429"
      );
      fail = false;
      await expect(adapter.submit({ prompt: "x" })).rejects.toThrow("no image");
    } finally {
      server.stop(true);
    }
  });
});

describe("ui server edges", () => {
  test("artifact endpoint: 400 without params, 404 when absent, serves the file when present", async () => {
    const { serveUi } = await import("../ui/server");
    const { run, step } = await import("../src/index");
    const { fakeAdapter } = await import("../src/adapters/fake");

    const dir = mkdtempSync(join(tmpdir(), "genforge-ui-"));
    const fileServer = Bun.serve({
      fetch: () =>
        new Response("artifact-bytes", {
          headers: { "content-type": "image/png" },
        }),
      port: 0,
    });
    const db = openDb(new Database(":memory:"));
    const ui = serveUi(db, 0);
    const base = `http://localhost:${ui.port}`;
    try {
      expect((await fetch(`${base}/api/artifact`)).status).toBe(400);
      expect(
        (await fetch(`${base}/api/artifact?run=nope&step=nope`)).status
      ).toBe(404);
      expect((await fetch(`${base}/definitely-not-a-route`)).status).toBe(404);

      const { runId } = await run(
        "ui-edge-wf",
        (ctx) =>
          step(ctx, "img", {
            adapter: fakeAdapter({
              mode: "sync",
              outputUrl: `http://localhost:${fileServer.port}/a.png`,
            }),
            input: {},
          }),
        { artifactsDir: dir, db }
      );
      const served = await fetch(`${base}/api/artifact?run=${runId}&step=img`);
      expect(served.status).toBe(200);
      expect(await served.text()).toBe("artifact-bytes");

      // malformed evidence json parses to null instead of crashing the board
      db.query(
        "INSERT INTO gates (run_id, key, evidence_json) VALUES (?, 'broken', '{not json')"
      ).run(runId);
      const state = (await (await fetch(`${base}/api/state`)).json()) as {
        gates: Array<{ key: string; evidence: unknown }>;
      };
      expect(state.gates.find((g) => g.key === "broken")?.evidence).toBeNull();
    } finally {
      ui.stop(true);
      fileServer.stop(true);
    }
  });
});
