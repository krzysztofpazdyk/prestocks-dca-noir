/** Enough of a RunRecord to pick the newest purchase. */
export type RunOrderFields = {
  runIndex: unknown;
  ts: unknown;
};

function asNum(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    value &&
    typeof value === "object" &&
    "toNumber" in value &&
    typeof (value as { toNumber: () => number }).toNumber === "function"
  ) {
    const n = (value as { toNumber: () => number }).toNumber();
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Newer first: higher runIndex, then higher ts. */
export function compareRunsNewestFirst(a: RunOrderFields, b: RunOrderFields): number {
  const indexDelta = asNum(b.runIndex) - asNum(a.runIndex);
  if (indexDelta !== 0) return indexDelta;
  return asNum(b.ts) - asNum(a.ts);
}

/** The RunRecord with the highest runIndex, breaking ties by ts. */
export function newestRunRecord<T extends RunOrderFields>(runs: readonly T[]): T | null {
  if (runs.length === 0) return null;
  let best = runs[0];
  for (let i = 1; i < runs.length; i++) {
    if (compareRunsNewestFirst(runs[i], best) < 0) best = runs[i];
  }
  return best;
}

/** Copy sorted so index 0 is the same record `newestRunRecord` returns. */
export function runsNewestFirst<T extends RunOrderFields>(runs: readonly T[]): T[] {
  return [...runs].sort(compareRunsNewestFirst);
}
