/**
 * On-chain PriceFeed (IDL account). Cached ~30s for the buy confirmation line.
 * `price` is USD per one whole token, scaled by 10^priceDecimals.
 * Minted base units (6 decimals) = floor(usdcRaw * 10^priceDecimals / price).
 */

import { PublicKey } from "@solana/web3.js";
import { priceFeedPda, programId } from "@/lib/predca";

/** PriceFeed account discriminator from idl/predca.json. */
export const PRICE_FEED_DISC = Uint8Array.from([
  189, 103, 252, 23, 152, 35, 243, 156,
]);

/** 8 disc + 32 mint + 8 price + 1 decimals + 8 ts + 8 slot + 8 maxAge + 1 bump. */
export const PRICE_FEED_LEN = 74;

export const PRICE_FEED_CACHE_MS = 30_000;

export type DecodedPriceFeed = {
  mint: PublicKey;
  price: bigint;
  priceDecimals: number;
  updatedTs: bigint;
  updatedSlot: bigint;
  maxAgeSecs: bigint;
  bump: number;
};

type AccountInfo = { data: Uint8Array; owner: PublicKey } | null;

type FeedReader = {
  getMultipleAccountsInfo(keys: PublicKey[]): Promise<AccountInfo[]>;
};

function readU64(data: Uint8Array, off: number): bigint {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(off, true);
}

function readI64(data: Uint8Array, off: number): bigint {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigInt64(off, true);
}

export function decodePriceFeedAccount(
  account: AccountInfo,
  program: PublicKey,
): DecodedPriceFeed | null {
  if (!account) return null;
  const data = account.data;
  if (data.length < PRICE_FEED_LEN) return null;
  if (!account.owner.equals(program)) return null;
  for (let i = 0; i < PRICE_FEED_DISC.length; i++) {
    if (data[i] !== PRICE_FEED_DISC[i]) return null;
  }
  let off = 8;
  const mint = new PublicKey(data.subarray(off, off + 32));
  off += 32;
  const price = readU64(data, off);
  off += 8;
  const priceDecimals = data[off];
  off += 1;
  const updatedTs = readI64(data, off);
  off += 8;
  const updatedSlot = readU64(data, off);
  off += 8;
  const maxAgeSecs = readI64(data, off);
  off += 8;
  const bump = data[off];
  return { mint, price, priceDecimals, updatedTs, updatedSlot, maxAgeSecs, bump };
}

/**
 * Token base units (6 decimals) minted for one leg.
 * floor(usdcRaw * 10^priceDecimals / priceRaw).
 */
export function mintedBaseUnits(
  usdcRaw: bigint,
  priceRaw: bigint,
  priceDecimals: number,
): bigint {
  if (priceRaw <= BigInt(0)) return BigInt(0);
  if (!Number.isInteger(priceDecimals) || priceDecimals < 0 || priceDecimals > 18) return BigInt(0);
  const scale = BigInt(10) ** BigInt(priceDecimals);
  return (usdcRaw * scale) / priceRaw;
}

export function wholeTokensFromBase(baseUnits: bigint, decimals = 6): number {
  const n = Number(baseUnits) / 10 ** decimals;
  return Number.isFinite(n) ? n : 0;
}

export function usdPerToken(priceRaw: bigint, priceDecimals: number): number | null {
  if (priceRaw <= BigInt(0)) return null;
  if (!Number.isInteger(priceDecimals) || priceDecimals < 0 || priceDecimals > 18) return null;
  const n = Number(priceRaw) / 10 ** priceDecimals;
  return Number.isFinite(n) && n > 0 ? n : null;
}

type CacheRow = { at: number; feed: DecodedPriceFeed | null };
const cache = new Map<string, CacheRow>();

/** Test hook. Production callers leave the module cache alone. */
export function clearPriceFeedCache(): void {
  cache.clear();
}

/**
 * Read PriceFeed PDAs. A hit younger than 30s skips RPC.
 * A thrown read leaves that mint uncached so the next call can retry.
 */
export async function fetchPriceFeedsCached(
  connection: FeedReader,
  mints: PublicKey[],
  now = Date.now(),
  program: PublicKey = programId(),
): Promise<Array<DecodedPriceFeed | null>> {
  const out: Array<DecodedPriceFeed | null> = mints.map(() => null);
  const missing: number[] = [];
  mints.forEach((mint, i) => {
    const hit = cache.get(mint.toBase58());
    if (hit && now - hit.at < PRICE_FEED_CACHE_MS) {
      out[i] = hit.feed;
    } else {
      missing.push(i);
    }
  });
  if (missing.length === 0) return out;
  let infos: AccountInfo[];
  try {
    infos = await connection.getMultipleAccountsInfo(
      missing.map((i) => priceFeedPda(mints[i], program)[0]),
    );
  } catch {
    return out;
  }
  missing.forEach((idx, j) => {
    const decoded = decodePriceFeedAccount(infos[j] ?? null, program);
    const feed = decoded && decoded.mint.equals(mints[idx]) ? decoded : null;
    cache.set(mints[idx].toBase58(), { at: now, feed });
    out[idx] = feed;
  });
  return out;
}
