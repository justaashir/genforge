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
const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * Gate verdicts authorize money, and "localhost-only" does not stop the
 * user's own browser: any webpage can fire a no-preflight POST at
 * localhost:4321 (CSRF), and DNS rebinding can fake the hostname. So: the
 * Host header must be a localhost form, and when a browser sends an Origin
 * it must be localhost too. CLI tools send no Origin and pass.
 */
function isLocalRequest(req: Request): boolean {
  const host = req.headers.get("host");
  if (!(host && LOCAL_HOST_RE.test(host))) {
    return false;
  }
  const origin = req.headers.get("origin");
  if (!origin) {
    return true;
  }
  try {
    return LOCAL_HOST_RE.test(new URL(origin).host);
  } catch {
    return false;
  }
}

export function serveUi(db: Database, port = 4321) {
  return Bun.serve({
    fetch: async (req) => {
      if (!isLocalRequest(req)) {
        return new Response("forbidden: genforge UI is localhost-only", {
          status: 403,
        });
      }
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
        return await handleVerdict(db, Number(verdictMatch[1]), req);
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

async function handleVerdict(
  db: Database,
  gateId: number,
  req: Request
): Promise<Response> {
  const body = (await req.json()) as {
    verdict: "keep" | "reject";
    note?: string;
  };
  if (body.verdict !== "keep" && body.verdict !== "reject") {
    return new Response("verdict must be keep|reject", { status: 400 });
  }
  setGateVerdict(db, gateId, body.verdict, body.note);
  return Response.json({ ok: true });
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
