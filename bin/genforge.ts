#!/usr/bin/env bun
// genforge CLI — dev (review UI) | ls | gates | verdict | spend
import { DEFAULT_DB_PATH, openDb } from "../src/db";
import {
  listGates,
  listRuns,
  listSteps,
  setGateVerdict,
  totalSpend,
} from "../src/ledger";

const argv: string[] = process.argv.slice(2);
const command: string | undefined = argv[0];
const args: string[] = argv.slice(1);
const dbFlagIndex = args.indexOf("--db");
const dbPath =
  dbFlagIndex === -1
    ? DEFAULT_DB_PATH
    : (args[dbFlagIndex + 1] ?? DEFAULT_DB_PATH);

const HELP = `genforge — spend-aware durable steps for paid AI APIs

usage:
  genforge dev [--db path] [--port n]   start the review UI (default :4321)
  genforge ls [--db path]               list runs with status + spend
  genforge gates [--db path]            list pending review gates
  genforge verdict <gateId> keep|reject [note...]
  genforge spend [--db path]            total ledger spend
`;

switch (command) {
  case "dev": {
    const portFlag = args.indexOf("--port");
    const port = portFlag === -1 ? 4321 : Number(args[portFlag + 1]);
    const { serveUi } = await import("../ui/server");
    const server = serveUi(openDb(dbPath), port);
    console.log(`genforge review UI → http://localhost:${server.port}`);
    break;
  }
  case "ls": {
    const db = openDb(dbPath);
    for (const runRow of listRuns(db)) {
      const steps = listSteps(db, runRow.id);
      const spent = steps.reduce(
        (sum, s) => sum + (s.cost_usd ?? s.reserved_usd),
        0
      );
      console.log(
        `${runRow.id.slice(0, 8)}  ${runRow.status.padEnd(8)}  $${spent.toFixed(3).padStart(8)}  ${runRow.workflow}`
      );
    }
    break;
  }
  case "gates": {
    const db = openDb(dbPath);
    for (const g of listGates(db, true)) {
      console.log(`#${g.id}  run ${g.run_id.slice(0, 8)}  ${g.key}`);
    }
    break;
  }
  case "verdict": {
    const [idRaw, verdict, ...noteParts] = args;
    if (!idRaw || (verdict !== "keep" && verdict !== "reject")) {
      console.error("usage: genforge verdict <gateId> keep|reject [note...]");
      process.exit(1);
    }
    const db = openDb(dbPath);
    setGateVerdict(
      db,
      Number(idRaw),
      verdict,
      noteParts.join(" ") || undefined
    );
    console.log(`gate #${idRaw} → ${verdict}`);
    break;
  }
  case "spend": {
    const db = openDb(dbPath);
    console.log(`$${totalSpend(db).toFixed(4)}`);
    break;
  }
  default:
    console.log(HELP);
}
