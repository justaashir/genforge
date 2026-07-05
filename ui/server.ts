// Review UI server — one Bun.serve over the same sqlite ledger. The blocked
// gate() call in the workflow process polls the gates table; this server just
// writes verdicts into it. Dumb and correct beats websockets.
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  getStep as getStepByKey,
  listGates,
  listRuns,
  listSteps,
  setGateVerdict,
  totalSpend,
} from "../src/ledger";

const INDEX_PATH = join(import.meta.dir, "index.html");
const VERDICT_ROUTE_RE = /^\/api\/gates\/(\d+)\/verdict$/;

export function serveUi(db: Database, port = 4321) {
  return Bun.serve({
    fetch: async (req) => {
      const url = new URL(req.url);

      if (url.pathname === "/") {
        return new Response(Bun.file(INDEX_PATH));
      }

      if (url.pathname === "/api/state") {
        const runs = listRuns(db).map((r) => ({
          ...r,
          steps: listSteps(db, r.id),
        }));
        const gates = listGates(db).map((g) => ({
          ...g,
          evidence: safeParse(g.evidence_json),
        }));
        return Response.json({ gates, runs, totalSpend: totalSpend(db) });
      }

      const verdictMatch = url.pathname.match(VERDICT_ROUTE_RE);
      if (verdictMatch?.[1] && req.method === "POST") {
        const body = (await req.json()) as {
          verdict: "keep" | "reject";
          note?: string;
        };
        if (body.verdict !== "keep" && body.verdict !== "reject") {
          return new Response("verdict must be keep|reject", { status: 400 });
        }
        setGateVerdict(db, Number(verdictMatch[1]), body.verdict, body.note);
        return Response.json({ ok: true });
      }

      if (url.pathname === "/api/artifact") {
        const runId = url.searchParams.get("run");
        const key = url.searchParams.get("step");
        if (!(runId && key)) {
          return new Response("run + step required", { status: 400 });
        }
        const stepRow = getStepByKey(db, runId, key);
        if (!stepRow?.artifact_path) {
          return new Response("no local artifact", { status: 404 });
        }
        return new Response(Bun.file(stepRow.artifact_path));
      }

      return new Response("not found", { status: 404 });
    },
    port,
  });
}

function safeParse(json: string | null): unknown {
  if (!json) {
    return null;
  }
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
