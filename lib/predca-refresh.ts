/**
 * A refresh may write only for the wallet epoch and pubkey it started with.
 * Switch or disconnect makes this false, so a late Devnet read cannot land
 * on the next wallet or clear that wallet's loading flag.
 */

import {
  nextSnapshotAfterRefresh,
  type PredcaSnapshot,
  type RefreshOutcome,
} from "@/lib/predca-status";
import {
  effectiveRunPricePresence,
  isYoungRunTs,
  mergeRunPrices,
} from "@/lib/run-price";
import {
  runLots,
  tokenBalancesCoverLots,
  type DecodedLots,
  type RunLotSource,
  type TokenAmount,
} from "@/lib/position-value";

export function refreshWriteStillCurrent(
  epochAtStart: number,
  ownerAtStart: string | null,
  epochNow: number,
  ownerNow: string | null,
): boolean {
  return epochAtStart === epochNow && ownerAtStart === ownerNow;
}

/**
 * Jupiter prices for one refresh. The returned promise stays pending while
 * `load` does, so the caller must not await it. A quote is applied only while
 * `still` is true. Rejection is swallowed; `setLoading(false)` runs only for
 * the same wallet epoch.
 */
export function loadJupPricesInBackground<T>(
  load: () => Promise<T>,
  still: () => boolean,
  apply: (value: T) => void,
  setLoading: (loading: boolean) => void,
): Promise<void> {
  return (async () => {
    setLoading(true);
    try {
      const value = await load();
      if (!still()) return;
      apply(value);
    } catch {
      /* a price failure must not surface on the RPC path */
    } finally {
      if (still()) setLoading(false);
    }
  })();
}

/** On-chain + Jupiter poll. Visible tab only, and never over a tx or a read. */
export const CHAIN_POLL_MS = 45_000;

export const POST_TX_REFRESH_ATTEMPTS = 3;
export const POST_TX_REFRESH_GAP_MS = 2_500;

export function chainPollDecision(input: {
  visibilityState: string;
  txPending: boolean;
  loading: boolean;
  refreshInFlight: boolean;
}): "poll" | "skip" {
  if (input.visibilityState !== "visible") return "skip";
  if (input.txPending || input.loading || input.refreshInFlight) return "skip";
  return "poll";
}

/**
 * Critical reads always start. Poll and any other non-critical source wait
 * until the in-flight read finishes. Omitted source is critical (mount,
 * keeper, and action calls pass no opts). Nested post-tx reads stay on the
 * outer flight and are not skipped here.
 */
export const CRITICAL_REFRESH_SOURCES = [
  "critical",
  "owner",
  "disconnect",
  "keeper",
  "afterTx",
  "manual",
] as const;

export type CriticalRefreshSource = (typeof CRITICAL_REFRESH_SOURCES)[number];

export type RefreshCallSource = "poll" | CriticalRefreshSource;

export function refreshCallDecision(input: {
  source?: string;
  inFlight: boolean;
  nested?: boolean;
}): "run" | "skip" {
  if (input.nested) return "run";
  const source = input.source ?? "critical";
  if ((CRITICAL_REFRESH_SOURCES as readonly string[]).includes(source)) return "run";
  return input.inFlight ? "skip" : "run";
}

export type RunMeta = { runIndex: number; ts: number };

/**
 * Successful RunPrice read replaces the map, then drops a null on a run younger
 * than ~60s so it stays unknown instead of legacy 1:1. A failed read keeps
 * the previous map (new runs are simply absent).
 */
export function pricesAfterRead<T>(
  prev: ReadonlyMap<number, T | null>,
  next: { map: ReadonlyMap<number, T | null>; ok: boolean },
  runs: RunMeta[],
  nowMs: number,
): Map<number, T | null> {
  if (!next.ok) return new Map(prev);
  const merged = mergeRunPrices(prev, next);
  for (const run of runs) {
    if (!merged.has(run.runIndex)) continue;
    if (merged.get(run.runIndex) != null) continue;
    if (isYoungRunTs(run.ts, nowMs)) merged.delete(run.runIndex);
  }
  return merged;
}

/**
 * One commit for the chain snapshot and the RunPrice map.
 * `prices.ok === false` does not pretend the new runs are priced: the previous
 * map is kept (new indices are unknown) and `priceWarning` is set. `rpcError`
 * stays clear so a price miss does not block purchase.
 */
export function commitRefreshRead<T>(input: {
  prevSnapshot: PredcaSnapshot;
  prevPrices: ReadonlyMap<number, T | null>;
  outcome: RefreshOutcome;
  prices: { map: ReadonlyMap<number, T | null>; ok: boolean };
  runMeta: RunMeta[];
  nowMs: number;
}): { snapshot: PredcaSnapshot; prices: Map<number, T | null> } {
  if (!input.outcome.ok) {
    return {
      snapshot: nextSnapshotAfterRefresh(input.prevSnapshot, input.outcome),
      prices: new Map(input.prevPrices),
    };
  }
  const snapshot = nextSnapshotAfterRefresh(input.prevSnapshot, input.outcome);
  const prices = pricesAfterRead(
    input.prevPrices,
    input.prices,
    input.runMeta,
    input.nowMs,
  );
  const unknown = input.runMeta.some(
    (run) =>
      effectiveRunPricePresence(prices, run.runIndex, run.ts, input.nowMs) === "unknown",
  );
  return {
    snapshot: {
      ...snapshot,
      priceWarning: !input.prices.ok || unknown ? "runPrice.loading" : null,
    },
    prices,
  };
}

export function vaultMoved(
  before: number | null,
  after: number | null,
  direction: "up" | "down",
): boolean {
  if (before == null || after == null) return false;
  if (!Number.isFinite(before) || !Number.isFinite(after)) return false;
  const eps = 1e-6;
  return direction === "up" ? after > before + eps : after < before - eps;
}

/** Buy is consistent when the new run exists, its RunPrice decoded, and ATAs cover lot units. */
export function buyRefreshSettled(input: {
  prevRunCount: number;
  expectedRunIndex: number | null;
  runs: RunLotSource[];
  prices: ReadonlyMap<number, DecodedLots | null>;
  balances: TokenAmount[];
  nowMs: number;
}): boolean {
  const hasIndex =
    input.expectedRunIndex != null &&
    input.runs.some((run) => run.runIndex === input.expectedRunIndex);
  const grew = input.runs.length > input.prevRunCount;
  if (!hasIndex && !grew) return false;
  const fresh = input.runs.filter((run, index) => {
    if (hasIndex && run.runIndex === input.expectedRunIndex) return true;
    return index >= input.prevRunCount;
  });
  if (fresh.length === 0) return false;
  for (const run of fresh) {
    if (
      effectiveRunPricePresence(input.prices, run.runIndex, run.ts, input.nowMs) !== "decoded"
    ) {
      return false;
    }
  }
  return tokenBalancesCoverLots(runLots(input.runs, input.prices, input.nowMs), input.balances);
}

/**
 * A post-tx retry only counts a read that actually returned.
 * `rpcError` and a soft timeout are failed attempts: the caller retries, and
 * must not treat the kept snapshot as "the buy is visible".
 */
export function postTxReadAttempt<
  T extends { softTimeout?: boolean; snapshot: { rpcError: string | null } },
>(commit: T | null): T | null {
  if (commit == null) return null;
  if (commit.softTimeout) return null;
  if (commit.snapshot.rpcError) return null;
  return commit;
}

/**
 * In-flight flags belong to the refresh that still owns `myGen`.
 * A newer pass bumps the counter; the older `finally` must not clear them.
 */
export function flightMayRelease(currentGen: number, myGen: number): boolean {
  return currentGen === myGen;
}

/**
 * At most `attempts` refreshes, `gapMs` apart. Stops early when `settled` or
 * when `still` is false so a stale epoch cannot overwrite a newer read.
 */
export async function retryRefresh<T>(opts: {
  attempts?: number;
  gapMs?: number;
  still: () => boolean;
  refresh: () => Promise<T | null>;
  settled: (value: T) => boolean;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ attempts: number; settled: boolean; last: T | null }> {
  const attemptsMax = opts.attempts ?? POST_TX_REFRESH_ATTEMPTS;
  const gapMs = opts.gapMs ?? POST_TX_REFRESH_GAP_MS;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let attempts = 0;
  let last: T | null = null;
  for (let i = 0; i < attemptsMax; i++) {
    if (!opts.still()) return { attempts, settled: false, last };
    attempts += 1;
    const value = await opts.refresh();
    if (value != null) last = value;
    if (!opts.still()) return { attempts, settled: false, last };
    if (value != null && opts.settled(value)) {
      return { attempts, settled: true, last: value };
    }
    if (i + 1 < attemptsMax) await sleep(gapMs);
  }
  return { attempts, settled: false, last };
}

/**
 * Price-only refresh. Does not read RPC and does not write portfolio state.
 * Applies the loaded value only while `still()` is true.
 */
export async function refreshPrices<T>(
  load: () => Promise<T>,
  still: () => boolean,
  apply: (value: T) => void,
): Promise<void> {
  const value = await load();
  if (!still()) return;
  apply(value);
}

