/**
 * Optional v2 RunPrice account. Missing or invalid → caller treats the lot as legacy.
 * RunPrice is not in the IDL. Layout (borsh, no padding) after the 8-byte
 * discriminator sha256("account:RunPrice")[0..8]:
 * owner pubkey · run_index u64 · mints [pubkey;3] · prices [u64;3] ·
 * price_decimals [u8;3] · price_ts [i64;3] · usdc_spent_each u64 · version u8 · bump u8
 * = 197 bytes, 205 with the discriminator.
 *
 * `usdc_spent_each` is one raw USDC amount (6 decimals) spent on each of the
 * three legs. `prices[i]` is USD per one whole token, scaled by 10^price_decimals[i].
 * Token amounts live on RunRecord.amounts, not here.
 * Lot price prefers the on-chain price; otherwise usdc spent / token amount.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { programId, runPricePda } from "@/lib/predca";
import { readTimeoutMs, withTimeout } from "@/lib/rpc-timeout";

export { runPricePda };

/** sha256("account:RunPrice").subarray(0, 8) */
export const RUN_PRICE_DISC = Uint8Array.from([
  164, 96, 163, 110, 17, 106, 42, 211,
]);

export const RUN_PRICE_LEN = 205;

export type DecodedRunPrice = {
  owner: PublicKey;
  runIndex: number;
  mints: [PublicKey, PublicKey, PublicKey];
  prices: [bigint, bigint, bigint];
  priceDecimals: [number, number, number];
  priceTs: [bigint, bigint, bigint];
  /** Raw USDC (6 decimals) spent on each leg. */
  usdcSpentEach: bigint;
  version: number;
  bump: number;
};

function readU64(data: Uint8Array, off: number): bigint {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(off, true);
}

function readI64(data: Uint8Array, off: number): bigint {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigInt64(off, true);
}

function readPubkey(data: Uint8Array, off: number): PublicKey {
  return new PublicKey(data.subarray(off, off + 32));
}

/**
 * null account → null (legacy). Bad discriminator, length, or program owner → null + warn.
 */
export function decodeRunPriceAccount(
  account: { data: Uint8Array; owner: PublicKey } | null,
  program: PublicKey,
): DecodedRunPrice | null {
  if (!account) return null;
  const data = account.data;
  if (data.length !== RUN_PRICE_LEN) {
    console.warn("RunPrice: zła długość", data.length);
    return null;
  }
  if (!account.owner.equals(program)) {
    console.warn("RunPrice: owner ≠ program");
    return null;
  }
  for (let i = 0; i < RUN_PRICE_DISC.length; i++) {
    if (data[i] !== RUN_PRICE_DISC[i]) {
      console.warn("RunPrice: zły dyskryminator");
      return null;
    }
  }
  let off = 8;
  const owner = readPubkey(data, off);
  off += 32;
  const runIndex = Number(readU64(data, off));
  off += 8;
  const mints: [PublicKey, PublicKey, PublicKey] = [
    readPubkey(data, off),
    readPubkey(data, off + 32),
    readPubkey(data, off + 64),
  ];
  off += 96;
  const prices: [bigint, bigint, bigint] = [
    readU64(data, off),
    readU64(data, off + 8),
    readU64(data, off + 16),
  ];
  off += 24;
  const priceDecimals: [number, number, number] = [data[off], data[off + 1], data[off + 2]];
  off += 3;
  const priceTs: [bigint, bigint, bigint] = [
    readI64(data, off),
    readI64(data, off + 8),
    readI64(data, off + 16),
  ];
  off += 24;
  const usdcSpentEach = readU64(data, off);
  off += 8;
  const version = data[off];
  off += 1;
  const bump = data[off];
  return {
    owner,
    runIndex,
    mints,
    prices,
    priceDecimals,
    priceTs,
    usdcSpentEach,
    version,
    bump,
  };
}

/** USD per one whole token. Null when the raw price is zero or the scale is unusable. */
export function scaledUsdPrice(raw: bigint | number, decimals: number): number | null {
  const n = typeof raw === "bigint" ? Number(raw) : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) return null;
  const px = n / 10 ** decimals;
  return Number.isFinite(px) && px > 0 ? px : null;
}

/**
 * Lot price fallback: USDC spent on the leg / token amount.
 * Both inputs are raw base units (6 decimals), so the ratio is USD per whole token.
 */
export function lotPriceFromSpend(
  usdcSpentRaw: bigint | number,
  tokenBaseUnits: bigint | number,
): number | null {
  const usdc = typeof usdcSpentRaw === "bigint" ? Number(usdcSpentRaw) : Number(usdcSpentRaw);
  const tokens = typeof tokenBaseUnits === "bigint" ? Number(tokenBaseUnits) : Number(tokenBaseUnits);
  if (!Number.isFinite(usdc) || !Number.isFinite(tokens) || usdc <= 0 || tokens <= 0) {
    return null;
  }
  const px = usdc / tokens;
  return Number.isFinite(px) && px > 0 ? px : null;
}

export type RunPriceFetch = {
  map: Map<number, DecodedRunPrice | null>;
  ok: boolean;
};

/**
 * Keep the previous map when the RPC read failed.
 * A successful read replaces the map, including real nulls (no RunPrice account).
 */
export function mergeRunPrices<T>(
  prev: ReadonlyMap<number, T | null>,
  next: { map: ReadonlyMap<number, T | null>; ok: boolean },
): Map<number, T | null> {
  if (!next.ok) return new Map(prev);
  return new Map(next.map);
}

/**
 * How a run sits in the RunPrice map.
 * `decoded` — account present. `missing` — key is present and null after a
 * successful read (legacy 1:1). `unknown` — key absent (read not done or failed).
 */
export type RunPricePresence = "decoded" | "missing" | "unknown";

/** A confirmed-missing account younger than this is still unknown (lagging RPC). */
export const YOUNG_RUN_PRICE_MS = 60_000;

export function runPricePresence<T>(
  map: ReadonlyMap<number, T | null>,
  runIndex: number,
): RunPricePresence {
  if (!map.has(runIndex)) return "unknown";
  return map.get(runIndex) == null ? "missing" : "decoded";
}

/** `tsSec` is RunRecord.ts (unix seconds). Non-positive timestamps are not young. */
export function isYoungRunTs(
  tsSec: number,
  nowMs: number,
  youngMs = YOUNG_RUN_PRICE_MS,
): boolean {
  if (!Number.isFinite(tsSec) || tsSec <= 0) return false;
  if (!Number.isFinite(nowMs)) return false;
  return nowMs - tsSec * 1000 < youngMs;
}

/**
 * Same as {@link runPricePresence}, except a missing account on a run younger
 * than {@link YOUNG_RUN_PRICE_MS} stays unknown. Delayed devnet RPC can report
 * "no account" for a RunPrice that simulate_buy_v2 just created.
 */
export function effectiveRunPricePresence<T>(
  map: ReadonlyMap<number, T | null>,
  runIndex: number,
  tsSec: number,
  nowMs: number,
): RunPricePresence {
  const presence = runPricePresence(map, runIndex);
  if (presence === "missing" && isYoungRunTs(tsSec, nowMs)) return "unknown";
  return presence;
}

/**
 * Batch-read RunPrice PDAs. RPC failure, including a timeout when `timeoutMs`
 * is set, returns ok false so the caller keeps the previous map.
 * Omitted `timeoutMs` does not add a deadline (tests and any non-refresh caller).
 */
export async function fetchRunPrices(
  connection: Connection,
  owner: PublicKey,
  runIndices: number[],
  timeoutMs?: number,
): Promise<RunPriceFetch> {
  const program = programId();
  const unique = [...new Set(runIndices)];
  const out = new Map<number, DecodedRunPrice | null>();
  for (const idx of unique) out.set(idx, null);
  const deadline = timeoutMs == null ? null : Date.now() + timeoutMs;
  try {
    for (let i = 0; i < unique.length; i += 100) {
      const slice = unique.slice(i, i + 100);
      const pdas = slice.map((idx) => runPricePda(owner, idx, program)[0]);
      const pending = connection.getMultipleAccountsInfo(pdas);
      const infos =
        deadline == null
          ? await pending
          : await withTimeout(pending, readTimeoutMs(deadline), "runPrices");
      infos.forEach((info, j) => {
        out.set(slice[j], decodeRunPriceAccount(info, program));
      });
    }
  } catch (e) {
    console.warn("RunPrice: odczyt nieudany, zostawiam poprzednią mapę", e);
    return { map: out, ok: false };
  }
  return { map: out, ok: true };
}
