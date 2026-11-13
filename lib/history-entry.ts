/**
 * One purchase, whatever wrote it. Event beats a chain RunRecord+RunPrice,
 * which beats the static snapshot, which beats the last-buy card.
 * Rows from a closed account stay in the same list. The key is
 * generation plus runIndex, so a new account's run 0 does not replace
 * the old account's run 0. Missing prices stay on the legacy path.
 */

import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import type { DecodedRunPrice } from "@/lib/run-price";
import { ORIGIN_AUTO, ORIGIN_MANUAL, type UserCard } from "@/lib/user-config";
import type { RunRecordData } from "@/lib/predca";

export type HistoryOrigin = "auto" | "manual";
export type HistorySource = "event" | "chain" | "snapshot" | "card";

/**
 * A successful close of this owner's account. `generation` counts closes whose
 * slot is strictly less than the purchase slot (0 = the oldest account).
 */
export type CloseMark = {
  slot: number;
  ts?: number;
  signature?: string;
};

export type HistoryEntry = {
  runIndex: number;
  /**
   * Account sequence. 0 is the oldest account. Omitted until `mergeHistory`
   * sees the close marks. Same `runIndex` on two accounts stays two rows.
   */
  generation?: number;
  /** Discreet marker: this purchase is from an account that was closed. */
  previousAccount?: boolean;
  origin: HistoryOrigin | null;
  mints: string[];
  /** Token base units (u64). Same raw field RunRecord.amounts carries. */
  amounts: bigint[];
  prices?: bigint[];
  priceDecimals?: number[];
  priceTs?: bigint[];
  /** Raw USDC (6 decimals) spent on each leg. */
  usdcEach: bigint;
  feeUsdc?: bigint;
  signature: string;
  slot: number;
  ts: number;
  source: HistorySource;
  /** False → same mark as a confirmed-missing RunPrice. */
  priceKnown: boolean;
  /**
   * False only when a chain read never returned this index (unknown, not legacy).
   * Omitted or true means the price account is confirmed missing.
   */
  priceMissing?: boolean;
};

const SOURCE_RANK: Record<HistorySource, number> = {
  event: 0,
  chain: 1,
  snapshot: 2,
  card: 3,
};

export function originFromFeePayer(
  feePayer: string | null | undefined,
  owner: string,
): HistoryOrigin {
  if (feePayer && feePayer === owner) return "manual";
  return "auto";
}

/**
 * 2 → manual, 1 → auto. 0, null, undefined, and any other code have no label.
 * A missing code must not be shown as an automatic purchase.
 */
export function originFromCode(origin: number | null | undefined): HistoryOrigin | null {
  if (origin === ORIGIN_MANUAL) return "manual";
  if (origin === ORIGIN_AUTO) return "auto";
  return null;
}

/** One close per slot. A repeated signature must not bump generation twice. */
export function normalizeCloses(closes: readonly CloseMark[]): CloseMark[] {
  const bySlot = new Map<number, CloseMark>();
  for (const mark of closes) {
    if (!Number.isInteger(mark.slot) || mark.slot < 0) continue;
    const prev = bySlot.get(mark.slot);
    if (!prev) {
      bySlot.set(mark.slot, mark);
      continue;
    }
    if ((prev.ts ?? 0) <= 0 && (mark.ts ?? 0) > 0) bySlot.set(mark.slot, mark);
  }
  return [...bySlot.values()].sort((a, b) => a.slot - b.slot);
}

/**
 * generation = how many successful closes have a slot strictly below this row.
 * The card is the account that exists now, so its generation is the close count
 * even when its slot is missing. A receipt dump from before the upgrade has no
 * close of its own: generation 0 unless its slot (or, when the slot is missing,
 * its timestamp) falls after a known close.
 */
export function accountGeneration(
  entry: Pick<HistoryEntry, "source" | "slot" | "ts">,
  closes: readonly CloseMark[],
): number {
  const marks = normalizeCloses(closes);
  if (entry.source === "card") return marks.length;
  if (entry.source === "snapshot") {
    if (entry.slot > 0) return marks.filter((mark) => mark.slot < entry.slot).length;
    const ts = entry.ts ?? 0;
    const timed = marks.filter((mark) => (mark.ts ?? 0) > 0);
    if (ts > 0 && timed.length > 0) {
      return timed.filter((mark) => (mark.ts ?? 0) < ts).length;
    }
    return 0;
  }
  return marks.filter((mark) => mark.slot < entry.slot).length;
}

export function historyMergeKey(generation: number, runIndex: number): string {
  return `${generation}:${runIndex}`;
}

/** Lot and fill maps stay numeric. Generation 0 keeps the raw run index. */
const LOT_GENERATION_STRIDE = 1_000_000_000;

export function historyLotKey(entry: Pick<HistoryEntry, "runIndex" | "generation">): number {
  const generation = entry.generation ?? 0;
  if (!Number.isInteger(generation) || generation <= 0) return entry.runIndex;
  return generation * LOT_GENERATION_STRIDE + entry.runIndex;
}

export function historyFillKey(runIndex: number, generation = 0): string {
  return String(historyLotKey({ runIndex, generation }));
}

function prefer(current: HistoryEntry, next: HistoryEntry): HistoryEntry {
  const currentRank = SOURCE_RANK[current.source];
  const nextRank = SOURCE_RANK[next.source];
  if (nextRank !== currentRank) return nextRank < currentRank ? next : current;
  if (next.priceKnown !== current.priceKnown) return next.priceKnown ? next : current;
  return current;
}

function stampEntry(entry: HistoryEntry, marks: readonly CloseMark[]): HistoryEntry {
  const generation = marks.length > 0 ? accountGeneration(entry, marks) : (entry.generation ?? 0);
  const previousAccount =
    marks.length > 0 ? generation < marks.length : entry.previousAccount === true;
  return { ...entry, generation, previousAccount };
}

/**
 * One row per `${generation}:${runIndex}`. Earlier groups do not beat a
 * higher-priority source. Closes order accounts; without them a row keeps
 * the generation it already has (otherwise 0).
 */
export function mergeHistory(
  groups: ReadonlyArray<readonly HistoryEntry[]>,
  closes: readonly CloseMark[] = [],
): HistoryEntry[] {
  const marks = normalizeCloses(closes);
  const best = new Map<string, HistoryEntry>();
  for (const group of groups) {
    for (const entry of group) {
      if (!Number.isInteger(entry.runIndex) || entry.runIndex < 0) continue;
      const stamped = stampEntry(entry, marks);
      const key = historyMergeKey(stamped.generation ?? 0, stamped.runIndex);
      const prev = best.get(key);
      best.set(key, prev ? prefer(prev, stamped) : stamped);
    }
  }
  return [...best.values()].sort((a, b) => {
    const gen = (a.generation ?? 0) - (b.generation ?? 0);
    if (gen !== 0) return gen;
    return a.runIndex - b.runIndex;
  });
}

function bnBig(value: BN | number | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  return BigInt(value.toString());
}

function bnNum(value: BN | number): number {
  if (typeof value === "number") return value;
  const n = Number(value.toString());
  return Number.isFinite(n) ? n : 0;
}

/** Chain RunRecord, plus RunPrice when that read returned one. */
export function entryFromChain(
  record: RunRecordData,
  price: DecodedRunPrice | null | undefined,
): HistoryEntry {
  const mints = record.mints.map((mint) =>
    typeof mint === "string" ? mint : mint.toBase58(),
  );
  const amounts = record.amounts.map((amount) => bnBig(amount));
  const known = price != null;
  return {
    runIndex: bnNum(record.runIndex),
    origin: null,
    mints,
    amounts,
    prices: known ? [...price.prices] : undefined,
    priceDecimals: known ? [...price.priceDecimals] : undefined,
    priceTs: known ? [...price.priceTs] : undefined,
    usdcEach: known ? price.usdcSpentEach : BigInt(0),
    signature: "",
    slot: bnNum(record.slot),
    ts: bnNum(record.ts),
    source: "chain",
    priceKnown: known,
    priceMissing: price === null,
  };
}

export function entriesFromChain(
  records: readonly RunRecordData[],
  prices: ReadonlyMap<number, DecodedRunPrice | null>,
): HistoryEntry[] {
  return records.map((record) => {
    const index = bnNum(record.runIndex);
    if (!prices.has(index)) return entryFromChain(record, undefined);
    return entryFromChain(record, prices.get(index) ?? null);
  });
}

/** Last purchase on the card, shown before events arrive. */
export function entryFromCard(
  cfg: { card?: UserCard | null } | null | undefined,
): HistoryEntry | null {
  const card = cfg?.card;
  if (!card || !card.hasLastRun) return null;
  const prices = card.lastPrices.map((price) => bnBig(price));
  return {
    runIndex: bnNum(card.lastRunIndex),
    origin: originFromCode(card.lastOrigin),
    mints: card.lastMints.map((mint) => mint.toBase58()),
    amounts: card.lastAmounts.map((amount) => bnBig(amount)),
    prices,
    priceDecimals: [...card.lastPriceDecimals],
    priceTs: card.lastPriceTs.map((ts) => bnBig(ts)),
    usdcEach: bnBig(card.lastUsdcEach),
    feeUsdc: bnBig(card.lastFeeUsdc),
    signature: "",
    slot: bnNum(card.lastSlot),
    ts: bnNum(card.lastBuyTs),
    source: "card",
    priceKnown: prices.some((price) => price > BigInt(0)),
    priceMissing: !prices.some((price) => price > BigInt(0)),
  };
}

export type HistoryLotRun = {
  runIndex: number;
  ts: number;
  mints: string[];
  amountsUsd: number[];
};

export type HistoryDecoded = {
  mints: { toBase58(): string }[];
  prices?: bigint[];
  priceDecimals?: number[];
  usdcSpentEach?: bigint;
  units?: bigint[];
  pricesE6?: bigint[];
};

/**
 * Same inputs `runLots` already uses. A priced entry becomes a decoded
 * RunPrice. An unpriced entry becomes a confirmed-missing account (null),
 * which is the legacy 1:1 mark once the run is older than the young window.
 */
export function historyToLotInputs(entries: readonly HistoryEntry[]): {
  runs: HistoryLotRun[];
  decoded: Map<number, HistoryDecoded | null>;
} {
  const runs: HistoryLotRun[] = [];
  const decoded = new Map<number, HistoryDecoded | null>();
  for (const entry of entries) {
    const key = historyLotKey(entry);
    runs.push({
      runIndex: key,
      ts: entry.ts,
      mints: entry.mints,
      amountsUsd: entry.amounts.map((amount) => Number(amount) / 1_000_000),
    });
    if (!entry.priceKnown || !entry.prices) {
      if (entry.priceMissing === false) continue;
      decoded.set(key, null);
      continue;
    }
    decoded.set(key, {
      mints: entry.mints.map((mint) => ({ toBase58: () => mint })),
      prices: entry.prices,
      priceDecimals: entry.priceDecimals,
      usdcSpentEach: entry.usdcEach,
    });
  }
  return { runs, decoded };
}

export function historyToFillRuns(entries: readonly HistoryEntry[]): Array<{
  runIndex: number;
  ts: number;
  mints: string[];
  tokenAmounts: number[];
}> {
  return entries.map((entry) => ({
    runIndex: historyLotKey(entry),
    ts: entry.ts,
    mints: entry.mints,
    tokenAmounts: entry.amounts.map((amount) => Number(amount) / 1_000_000),
  }));
}

export type HistoryRunView = RunRecordData & {
  generation: number;
  previousAccount: boolean;
};

export function entryToRunRecord(entry: HistoryEntry, owner: PublicKey): HistoryRunView {
  return {
    mints: entry.mints.map((mint) => new PublicKey(mint)),
    amounts: entry.amounts.map((amount) => new BN(amount.toString())),
    signatureHash: [],
    slot: new BN(entry.slot),
    ts: new BN(entry.ts),
    runIndex: new BN(entry.runIndex),
    owner,
    bump: 0,
    generation: entry.generation ?? 0,
    previousAccount: entry.previousAccount === true,
  };
}

/** Raw USDC per leg: explicit `usdc_each`, otherwise `usdc_burned / 3`. */
export function usdcEachFromEvent(usdcEach: bigint | null, usdcBurned: bigint | null): bigint {
  if (usdcEach != null && usdcEach > BigInt(0)) return usdcEach;
  if (usdcBurned != null && usdcBurned > BigInt(0)) return usdcBurned / BigInt(3);
  return BigInt(0);
}
