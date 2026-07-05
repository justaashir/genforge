import type { ResolvedPrice } from "../adapters/types";
import table from "./static.json";

type StaticEntry = {
  unit: string;
  usdPerUnit: number;
  asOf: string;
  note?: string;
};

type StaticTable = Record<string, Record<string, StaticEntry>>;

/**
 * Look up a model in the shipped, community-maintained price table.
 * Returns null for unknown models — the step layer then requires maxCost,
 * because an unknown price is never treated as free.
 */
export function staticPrice(
  provider: string,
  model: string
): ResolvedPrice | null {
  const providers = table as unknown as StaticTable;
  const entry = providers[provider]?.[model];
  if (!entry) {
    return null;
  }
  return { source: "static", unit: entry.unit, usdPerUnit: entry.usdPerUnit };
}
