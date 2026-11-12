/**
 * Purchase history from program events on the UserConfig account.
 * Signatures are paged by 100, capped on the first load. Parsed transactions
 * stay in localStorage and are not fetched again.
 */

import { BorshCoder, EventParser, type BN, type Idl } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import idl from "@/idl/predca.json";
import {
  originFromCode,
  originFromFeePayer,
  usdcEachFromEvent,
  type HistoryEntry,
  type HistoryOrigin,
} from "@/lib/history-entry";
import { RPC_READ_TIMEOUT_MS, withTimeout } from "@/lib/rpc-timeout";

export const HISTORY_PAGE_SIZE = 100;
export const HISTORY_INITIAL_SIGNATURE_CAP = 500;
export const HISTORY_TX_BATCH = 5;
export const HISTORY_CACHE_PREFIX = "noir.historyEvents.v1";

const BUY_EVENTS = new Set([
  "BuyV4Executed",
  "BuyV3Executed",
  "BuyV2Executed",
  "SimulateBuyExecuted",
  "RunRecorded",
]);

export type SignaturePageRow = { signature: string };

export type HistoryConnection = {
  getSignaturesForAddress(
    address: PublicKey,
    options?: { before?: string; limit?: number },
  ): Promise<ReadonlyArray<SignaturePageRow>>;
  getTransaction(
    signature: string,
    options?: { commitment?: "confirmed"; maxSupportedTransactionVersion?: number },
  ): Promise<HistoryTransaction | null>;
};

export type HistoryTransaction = {
  slot?: number;
  blockTime?: number | null;
  meta?: { logMessages?: string[] | null } | null;
  transaction?: {
    signatures?: string[];
    message?: {
      staticAccountKeys?: PublicKey[];
      accountKeys?: Array<PublicKey | string>;
    };
  };
};

type CacheFile = Record<string, HistoryEntry[]>;

export type HistoryCacheStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

let coderCache: BorshCoder | null = null;

function coder(): BorshCoder {
  if (!coderCache) coderCache = new BorshCoder(idl as Idl);
  return coderCache;
}

export function historyCacheKey(owner: string): string {
  return `${HISTORY_CACHE_PREFIX}.${owner}`;
}

export function readHistoryCache(storage: HistoryCacheStorage | null, owner: string): CacheFile {
  if (!storage) return {};
  try {
    const raw = storage.getItem(historyCacheKey(owner));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return reviveCache(parsed as Record<string, unknown>);
  } catch {
    return {};
  }
}

function reviveCache(raw: Record<string, unknown>): CacheFile {
  const out: CacheFile = {};
  for (const [signature, value] of Object.entries(raw)) {
    if (!Array.isArray(value)) continue;
    const entries: HistoryEntry[] = [];
    for (const row of value) {
      const entry = reviveEntry(row);
      if (entry) entries.push(entry);
    }
    out[signature] = entries;
  }
  return out;
}

function reviveEntry(row: unknown): HistoryEntry | null {
  if (!row || typeof row !== "object") return null;
  const e = row as Partial<HistoryEntry> & { amounts?: unknown; usdcEach?: unknown };
  if (typeof e.runIndex !== "number" || typeof e.source !== "string") return null;
  const amounts = Array.isArray(e.amounts) ? e.amounts.map((n) => BigInt(String(n))) : [];
  return {
    runIndex: e.runIndex,
    origin: e.origin === "manual" || e.origin === "auto" ? e.origin : null,
    mints: Array.isArray(e.mints) ? e.mints.map(String) : [],
    amounts,
    prices: Array.isArray(e.prices) ? e.prices.map((n) => BigInt(String(n))) : undefined,
    priceDecimals: Array.isArray(e.priceDecimals) ? e.priceDecimals.map(Number) : undefined,
    priceTs: Array.isArray(e.priceTs) ? e.priceTs.map((n) => BigInt(String(n))) : undefined,
    usdcEach: BigInt(String(e.usdcEach ?? 0)),
    feeUsdc: e.feeUsdc == null ? undefined : BigInt(String(e.feeUsdc)),
    signature: typeof e.signature === "string" ? e.signature : "",
    slot: typeof e.slot === "number" ? e.slot : 0,
    ts: typeof e.ts === "number" ? e.ts : 0,
    source: "event",
    priceKnown: e.priceKnown === true,
  };
}

function cachePayload(file: CacheFile): string {
  const plain: Record<string, unknown[]> = {};
  for (const [signature, entries] of Object.entries(file)) {
    plain[signature] = entries.map((entry) => ({
      ...entry,
      amounts: entry.amounts.map(String),
      prices: entry.prices?.map(String),
      priceTs: entry.priceTs?.map(String),
      usdcEach: entry.usdcEach.toString(),
      feeUsdc: entry.feeUsdc?.toString(),
    }));
  }
  return JSON.stringify(plain);
}

export function writeHistoryCache(
  storage: HistoryCacheStorage | null,
  owner: string,
  file: CacheFile,
): void {
  if (!storage) return;
  try {
    storage.setItem(historyCacheKey(owner), cachePayload(file));
  } catch {
    /* a full localStorage must not break history */
  }
}

export function cachedHistoryEntries(storage: HistoryCacheStorage | null, owner: string): HistoryEntry[] {
  const file = readHistoryCache(storage, owner);
  const out: HistoryEntry[] = [];
  for (const entries of Object.values(file)) out.push(...entries);
  return out;
}

export function clearHistoryCache(storage: HistoryCacheStorage | null, owner: string): void {
  if (!storage) return;
  try {
    storage.setItem(historyCacheKey(owner), "{}");
  } catch {
    /* ignore */
  }
}

/**
 * Page signatures until `cap` or the account runs out.
 * `before` continues after a previous oldest signature.
 */
export async function collectSignatures(
  fetchPage: (before: string | undefined, limit: number) => Promise<ReadonlyArray<SignaturePageRow>>,
  cap = HISTORY_INITIAL_SIGNATURE_CAP,
  pageSize = HISTORY_PAGE_SIZE,
  beforeStart?: string,
): Promise<{ signatures: string[]; exhausted: boolean; oldest: string | null }> {
  const signatures: string[] = [];
  let before = beforeStart;
  const limitCap = Math.max(0, Math.floor(cap));
  while (signatures.length < limitCap) {
    const limit = Math.min(pageSize, limitCap - signatures.length);
    const page = await fetchPage(before, limit);
    if (!Array.isArray(page) || page.length === 0) {
      return { signatures, exhausted: true, oldest: signatures.at(-1) ?? null };
    }
    for (const row of page) {
      if (row?.signature) signatures.push(row.signature);
    }
    const last = page[page.length - 1]?.signature;
    if (!last || page.length < limit) {
      return { signatures, exhausted: true, oldest: last ?? signatures.at(-1) ?? null };
    }
    if (last === before) {
      return { signatures, exhausted: true, oldest: last };
    }
    before = last;
  }
  return { signatures, exhausted: false, oldest: signatures.at(-1) ?? null };
}

function asBigint(value: unknown): bigint | null {
  if (value == null) return null;
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "object" && value !== null && "toString" in value) {
    try {
      return BigInt((value as BN).toString());
    } catch {
      return null;
    }
  }
  return null;
}

function asNumber(value: unknown): number {
  const n = asBigint(value);
  return n == null ? 0 : Number(n);
}

function asPubkey(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "toBase58" in value) {
    return (value as PublicKey).toBase58();
  }
  return "";
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function feePayerOf(tx: HistoryTransaction | null): string | null {
  const message = tx?.transaction?.message;
  if (!message) return null;
  const staticKey = message.staticAccountKeys?.[0];
  if (staticKey) return typeof staticKey === "string" ? staticKey : staticKey.toBase58();
  const key = message.accountKeys?.[0];
  if (!key) return null;
  return typeof key === "string" ? key : key.toBase58();
}

function field(data: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (name in data) return data[name];
  }
  return undefined;
}

/**
 * One buy event → one history row. BuyV4 origin comes from the event.
 * Older events use the transaction fee payer (owner = manual).
 */
export function entryFromBuyEvent(
  name: string,
  data: Record<string, unknown>,
  feePayer: string | null,
  owner: string,
  signature: string,
): HistoryEntry | null {
  if (!BUY_EVENTS.has(name)) return null;
  const mints = asArray(field(data, "mints")).map(asPubkey).filter((mint) => mint.length > 0);
  const amounts = asArray(field(data, "amounts")).map((value) => asBigint(value) ?? BigInt(0));
  const pricesRaw = field(data, "prices");
  const prices = Array.isArray(pricesRaw)
    ? pricesRaw.map((value) => asBigint(value) ?? BigInt(0))
    : undefined;
  const decimalsRaw = field(data, "price_decimals", "priceDecimals");
  const priceDecimals = Array.isArray(decimalsRaw) ? decimalsRaw.map((value) => Number(value)) : undefined;
  const priceTsRaw = field(data, "price_ts", "priceTs");
  const priceTs = Array.isArray(priceTsRaw)
    ? priceTsRaw.map((value) => asBigint(value) ?? BigInt(0))
    : undefined;
  const usdcEachField = asBigint(field(data, "usdc_each", "usdcEach"));
  const usdcBurned = asBigint(field(data, "usdc_burned", "usdcBurned"));
  const fee = asBigint(field(data, "fee_usdc", "feeUsdc"));
  const originField = field(data, "origin");
  const origin: HistoryOrigin | null =
    name === "BuyV4Executed"
      ? originFromCode(asNumber(originField))
      : originFromFeePayer(feePayer, owner);
  return {
    runIndex: asNumber(field(data, "run_index", "runIndex")),
    origin,
    mints,
    amounts,
    prices,
    priceDecimals,
    priceTs,
    usdcEach: usdcEachFromEvent(usdcEachField, usdcBurned),
    feeUsdc: fee ?? undefined,
    signature,
    slot: asNumber(field(data, "slot")),
    ts: asNumber(field(data, "ts")),
    source: "event",
    priceKnown: prices != null && prices.some((price) => price > BigInt(0)),
    priceMissing: !(prices != null && prices.some((price) => price > BigInt(0))),
  };
}

/** Events emitted by our program only. Other programs' `Program data:` lines are ignored. */
export function entriesFromLogs(
  logs: readonly string[],
  programId: PublicKey,
  owner: string,
  feePayer: string | null,
  signature: string,
): HistoryEntry[] {
  if (logs.length === 0) return [];
  const parser = new EventParser(programId, coder());
  const out: HistoryEntry[] = [];
  let parsed;
  try {
    parsed = [...parser.parseLogs([...logs])];
  } catch {
    return [];
  }
  for (const event of parsed) {
    const entry = entryFromBuyEvent(
      event.name,
      (event.data ?? {}) as Record<string, unknown>,
      feePayer,
      owner,
      signature,
    );
    if (entry) out.push(entry);
  }
  return out;
}

export function entriesFromTransaction(
  tx: HistoryTransaction | null,
  signature: string,
  owner: string,
  program: PublicKey,
): HistoryEntry[] {
  if (!tx) return [];
  const logs = tx.meta?.logMessages ?? [];
  return entriesFromLogs(logs, program, owner, feePayerOf(tx), signature);
}

export type HistoryPage = {
  entries: HistoryEntry[];
  exhausted: boolean;
  oldest: string | null;
  /** Transactions actually requested. A cache hit is not a request. */
  fetched: number;
};

/**
 * Load up to `cap` signatures and parse the ones that are not cached.
 * `getTransaction` runs in batches of 5 with the same read timeout as other RPC.
 */
export async function fetchHistoryEvents(args: {
  connection: HistoryConnection;
  address: PublicKey;
  owner: string;
  programId: PublicKey;
  storage?: HistoryCacheStorage | null;
  cap?: number;
  before?: string;
  timeoutMs?: number;
}): Promise<HistoryPage> {
  const timeoutMs = args.timeoutMs ?? RPC_READ_TIMEOUT_MS;
  const cache = readHistoryCache(args.storage ?? null, args.owner);
  const { signatures, exhausted, oldest } = await collectSignatures(
    (before, limit) =>
      withTimeout(
        args.connection.getSignaturesForAddress(args.address, {
          limit,
          ...(before ? { before } : {}),
        }),
        timeoutMs,
        "history-sigs",
      ),
    args.cap ?? HISTORY_INITIAL_SIGNATURE_CAP,
    HISTORY_PAGE_SIZE,
    args.before,
  );
  const missing = signatures.filter((signature) => !(signature in cache));
  let fetched = 0;
  for (let i = 0; i < missing.length; i += HISTORY_TX_BATCH) {
    const batch = missing.slice(i, i + HISTORY_TX_BATCH);
    const txs = await Promise.all(
      batch.map(async (signature) => {
        fetched += 1;
        try {
          return await withTimeout(
            args.connection.getTransaction(signature, {
              maxSupportedTransactionVersion: 0,
              commitment: "confirmed",
            }),
            timeoutMs,
            "history-tx",
          );
        } catch {
          return null;
        }
      }),
    );
    batch.forEach((signature, index) => {
      const tx = txs[index];
      cache[signature] = tx
        ? entriesFromTransaction(tx, signature, args.owner, args.programId)
        : [];
    });
  }
  writeHistoryCache(args.storage ?? null, args.owner, cache);
  const entries: HistoryEntry[] = [];
  for (const signature of signatures) {
    entries.push(...(cache[signature] ?? []));
  }
  return { entries, exhausted, oldest, fetched };
}

/**
 * Solana RPC for a first history load of N purchase transactions,
 * assuming each purchase is one signature and none are cached.
 * One `getSignaturesForAddress` page holds 100. Transactions go out in fives.
 */
export function historyRpcCost(purchases: number): { signatures: number; transactions: number; total: number } {
  const n = Math.max(0, Math.floor(purchases));
  const signatures = n === 0 ? 0 : Math.ceil(n / HISTORY_PAGE_SIZE);
  const transactions = Math.ceil(n / HISTORY_TX_BATCH);
  return { signatures, transactions, total: signatures + transactions };
}
