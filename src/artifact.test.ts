import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeAdapter } from "./adapters/fake";
import { run } from "./run";
import { step } from "./step";

const mem = () => new Database(":memory:");

describe("artifact download", () => {
  test("http output is downloaded to artifactsDir with the right extension", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]); // PNG magic
    const server = Bun.serve({
      fetch: () =>
        new Response(bytes, { headers: { "content-type": "image/png" } }),
      port: 0,
    });
    const url = `http://localhost:${server.port}/out.png`;
    const dir = mkdtempSync(join(tmpdir(), "genforge-"));
    const db = mem();
    try {
      const fake = fakeAdapter({ mode: "sync", outputUrl: url });
      let path = "";
      await run(
        "wf",
        async (ctx) => {
          const r = await step(ctx, "img", { adapter: fake, input: {} });
          path = r.path ?? "";
        },
        { artifactsDir: dir, db }
      );
      expect(path).toStartWith(dir);
      expect(path).toEndWith(".png");
      const saved = await Bun.file(path).bytes();
      expect(saved).toEqual(bytes);
    } finally {
      server.stop(true);
    }
  });

  test("non-http outputs (data:, provider-internal) are kept as url only", async () => {
    const db = mem();
    const fake = fakeAdapter({ mode: "sync" }); // default fake:// url
    let result: { url: string; path?: string } = { url: "" };
    await run(
      "wf",
      async (ctx) => {
        result = await step(ctx, "img", { adapter: fake, input: {} });
      },
      { db }
    );
    expect(result.url).toStartWith("fake://");
    expect(result.path).toBeUndefined();
  });
});
