/**
 * One purchase, whatever wrote it. Event beats a chain RunRecord+RunPrice,
 * which beats the static snapshot, which beats the last-buy card.
 * Missing prices stay on the same legacy path as a missing RunPrice.
 */

import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import type { DecodedRunPrice } from "@/lib/run-price";
import { ORIGIN_MANUAL, type UserCard } from "@/lib/user-config";
import type { RunRecordData } from "@/lib/predca";

export type HistoryOrigin = "auto" | "manual";
export type HistorySource = "event" | "chain" | "snapshot" | "card";

export type HistoryEntry = {
  runIndex: number;
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

export function originFromCode(origin: number | null | undefined): HistoryOrigin {
  return origin === ORIGIN_MANUAL ? "manual" : "auto";
}

function prefer(current: HistoryEntry, next: HistoryEntry): HistoryEntry {
  const currentRank = SOURCE_RANK[current.source];
  const nextRank = SOURCE_RANK[next.source];
  if (nextRank !== currentRank) return nextRank < currentRank ? next : current;
  if (next.priceKnown !== current.priceKnown) return next.priceKnown ? next : current;
  return current;
}

/** One row per runIndex. Earlier groups do not beat a higher-priority source. */
export function mergeHistory(groups: ReadonlyArray<readonly HistoryEntry[]>): HistoryEntry[] {
  const best = new Map<number, HistoryEntry>();
  for (const group of groups) {
    for (const entry of group) {
      if (!Number.isInteger(entry.runIndex) || entry.runIndex < 0) continue;
      const prev = best.get(entry.runIndex);
      best.set(entry.runIndex, prev ? prefer(prev, entry) : entry);
    }
  }
  return [...best.values()].sort((a, b) => a.runIndex - b.runIndex);
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
    runs.push({
      runIndex: entry.runIndex,
      ts: entry.ts,
      mints: entry.mints,
      amountsUsd: entry.amounts.map((amount) => Number(amount) / 1_000_000),
    });
    if (!entry.priceKnown || !entry.prices) {
      if (entry.priceMissing === false) continue;
      decoded.set(entry.runIndex, null);
      continue;
    }
    decoded.set(entry.runIndex, {
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
    runIndex: entry.runIndex,
    ts: entry.ts,
    mints: entry.mints,
    tokenAmounts: entry.amounts.map((amount) => Number(amount) / 1_000_000),
  }));
}

export function entryToRunRecord(entry: HistoryEntry, owner: PublicKey): RunRecordData {
  return {
    mints: entry.mints.map((mint) => new PublicKey(mint)),
    amounts: entry.amounts.map((amount) => new BN(amount.toString())),
    signatureHash: [],
    slot: new BN(entry.slot),
    ts: new BN(entry.ts),
    runIndex: new BN(entry.runIndex),
    owner,
    bump: 0,
  };
}

/** Raw USDC per leg: explicit `usdc_each`, otherwise `usdc_burned / 3`. */
export function usdcEachFromEvent(usdcEach: bigint | null, usdcBurned: bigint | null): bigint {
  if (usdcEach != null && usdcEach > BigInt(0)) return usdcEach;
  if (usdcBurned != null && usdcBurned > BigInt(0)) return usdcBurned / BigInt(3);
  return BigInt(0);
}
