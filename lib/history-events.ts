/**
 * Purchase history from program events on the UserConfig account.
 * Signatures are paged by 100, capped on the first load. A transaction is
 * cached only after a real read. A timeout or a missing transaction is left
 * out so the next refresh can try again. Cache key v2 drops the v1 file,
 * which had no account generation and could store an empty miss.
 */

import { BorshCoder, EventParser, type BN, type Idl } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import idl from "@/idl/predca.json";
import {
  originFromCode,
  originFromFeePayer,
  usdcEachFromEvent,
  type CloseMark,
  type HistoryEntry,
  type HistoryOrigin,
} from "@/lib/history-entry";
import { RPC_READ_TIMEOUT_MS, withTimeout } from "@/lib/rpc-timeout";

export const HISTORY_PAGE_SIZE = 100;
export const HISTORY_INITIAL_SIGNATURE_CAP = 500;
export const HISTORY_TX_BATCH = 5;
export const HISTORY_REFRESH_MS = 60_000;
export const HISTORY_CACHE_PREFIX = "noir.historyEvents.v2";
export const HISTORY_CACHE_LEGACY_PREFIX = "noir.historyEvents.v1";

const CLOSE_USER_LOG = /instruction:\s*close_?user\b/i;

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
    options?: { before?: string; until?: string; limit?: number },
  ): Promise<ReadonlyArray<SignaturePageRow>>;
  getTransaction(
    signature: string,
    options?: { commitment?: "confirmed"; maxSupportedTransactionVersion?: number },
  ): Promise<HistoryTransaction | null>;
};

export type HistoryInstruction = {
  programIdIndex: number;
  data?: Uint8Array | number[] | string;
};

export type HistoryTransaction = {
  slot?: number;
  blockTime?: number | null;
  meta?: { err?: unknown; logMessages?: string[] | null } | null;
  transaction?: {
    signatures?: string[];
    message?: {
      staticAccountKeys?: Array<PublicKey | string>;
      accountKeys?: Array<PublicKey | string>;
      compiledInstructions?: HistoryInstruction[];
      instructions?: HistoryInstruction[];
    };
  };
};

type CacheFile = {
  entries: Record<string, HistoryEntry[]>;
  closes: Record<string, { slot: number; ts: number }>;
};

function emptyCache(): CacheFile {
  return { entries: {}, closes: {} };
}

export type HistoryCacheStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
};

let coderCache: BorshCoder | null = null;

function coder(): BorshCoder {
  if (!coderCache) coderCache = new BorshCoder(idl as Idl);
  return coderCache;
}

export function historyCacheKey(owner: string): string {
  return `${HISTORY_CACHE_PREFIX}.${owner}`;
}

export function historyCacheLegacyKey(owner: string): string {
  return `${HISTORY_CACHE_LEGACY_PREFIX}.${owner}`;
}

function dropLegacyCache(storage: HistoryCacheStorage, owner: string): void {
  const legacy = historyCacheLegacyKey(owner);
  try {
    if (storage.getItem(legacy) == null) return;
    if (storage.removeItem) storage.removeItem(legacy);
  } catch {
    /* a stuck v1 file is ignored because reads use the v2 key */
  }
}

export function readHistoryCache(storage: HistoryCacheStorage | null, owner: string): CacheFile {
  if (!storage) return emptyCache();
  dropLegacyCache(storage, owner);
  try {
    const raw = storage.getItem(historyCacheKey(owner));
    if (!raw) return emptyCache();
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return emptyCache();
    return reviveCache(parsed as Record<string, unknown>);
  } catch {
    return emptyCache();
  }
}

function reviveCache(raw: Record<string, unknown>): CacheFile {
  const entriesRaw =
    raw.entries && typeof raw.entries === "object"
      ? (raw.entries as Record<string, unknown>)
      : null;
  if (!entriesRaw) return emptyCache();
  const entries: Record<string, HistoryEntry[]> = {};
  for (const [signature, value] of Object.entries(entriesRaw)) {
    if (!Array.isArray(value)) continue;
    const rows: HistoryEntry[] = [];
    for (const row of value) {
      const entry = reviveEntry(row);
      if (entry) rows.push(entry);
    }
    entries[signature] = rows;
  }
  const closes: CacheFile["closes"] = {};
  const closesRaw =
    raw.closes && typeof raw.closes === "object"
      ? (raw.closes as Record<string, unknown>)
      : {};
  for (const [signature, value] of Object.entries(closesRaw)) {
    if (!value || typeof value !== "object") continue;
    const mark = value as { slot?: unknown; ts?: unknown };
    if (typeof mark.slot !== "number" || mark.slot < 0) continue;
    closes[signature] = { slot: mark.slot, ts: typeof mark.ts === "number" ? mark.ts : 0 };
  }
  return { entries, closes };
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
    generation: typeof e.generation === "number" ? e.generation : undefined,
    previousAccount: e.previousAccount === true,
  };
}

function cachePayload(file: CacheFile): string {
  const entries: Record<string, unknown[]> = {};
  for (const [signature, rows] of Object.entries(file.entries)) {
    entries[signature] = rows.map((entry) => ({
      ...entry,
      amounts: entry.amounts.map(String),
      prices: entry.prices?.map(String),
      priceTs: entry.priceTs?.map(String),
      usdcEach: entry.usdcEach.toString(),
      feeUsdc: entry.feeUsdc?.toString(),
    }));
  }
  return JSON.stringify({ entries, closes: file.closes });
}

export function writeHistoryCache(
  storage: HistoryCacheStorage | null,
  owner: string,
  file: CacheFile,
): void {
  if (!storage) return;
  dropLegacyCache(storage, owner);
  try {
    storage.setItem(historyCacheKey(owner), cachePayload(file));
  } catch {
    /* a full localStorage must not break history */
  }
}

export function cachedHistoryEntries(storage: HistoryCacheStorage | null, owner: string): HistoryEntry[] {
  const file = readHistoryCache(storage, owner);
  const out: HistoryEntry[] = [];
  for (const entries of Object.values(file.entries)) out.push(...entries);
  return out;
}

export function cachedCloseMarks(storage: HistoryCacheStorage | null, owner: string): CloseMark[] {
  const file = readHistoryCache(storage, owner);
  const out: CloseMark[] = [];
  for (const [signature, mark] of Object.entries(file.closes)) {
    out.push({ signature, slot: mark.slot, ts: mark.ts });
  }
  return out;
}

export function clearHistoryCache(storage: HistoryCacheStorage | null, owner: string): void {
  if (!storage) return;
  dropLegacyCache(storage, owner);
  try {
    storage.setItem(historyCacheKey(owner), cachePayload(emptyCache()));
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
  const eventOwner = asPubkey(field(data, "owner"));
  if (eventOwner && eventOwner !== owner) return null;
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
  if (!tx || tx.meta?.err != null) return [];
  const logs = tx.meta?.logMessages ?? [];
  const entries = entriesFromLogs(logs, program, owner, feePayerOf(tx), signature);
  const slot = typeof tx.slot === "number" ? tx.slot : 0;
  const ts = typeof tx.blockTime === "number" ? tx.blockTime : 0;
  if (slot <= 0 && ts <= 0) return entries;
  return entries.map((entry) => ({
    ...entry,
    slot: entry.slot > 0 ? entry.slot : slot,
    ts: entry.ts > 0 ? entry.ts : ts,
  }));
}

function programKey(key: PublicKey | string | undefined): string {
  if (!key) return "";
  return typeof key === "string" ? key : key.toBase58();
}

/** Anchor `Instruction: CloseUser` while our program is the current invoke. */
export function logsContainCloseUser(logs: readonly string[], programId: PublicKey): boolean {
  const want = programId.toBase58();
  const stack: string[] = [];
  for (const line of logs) {
    const invoke = /^Program (\S+) invoke \[\d+\]/.exec(line);
    if (invoke) {
      stack.push(invoke[1]);
      continue;
    }
    const done = /^Program (\S+) (?:success|failed)/.exec(line);
    if (done) {
      const at = stack.lastIndexOf(done[1]);
      if (at >= 0) stack.splice(at, 1);
      else if (stack.length > 0) stack.pop();
      continue;
    }
    if (stack.at(-1) === want && CLOSE_USER_LOG.test(line)) return true;
  }
  return false;
}

function instructionBytes(data: HistoryInstruction["data"]): number[] | null {
  if (data == null || typeof data === "string") return null;
  if (data instanceof Uint8Array) return [...data.subarray(0, 8)];
  if (Array.isArray(data)) return data.slice(0, 8).map((byte) => Number(byte));
  return null;
}

function closeUserDiscriminator(): number[] {
  const list = (idl as { instructions?: Array<{ name: string; discriminator?: number[] }> }).instructions;
  return list?.find((item) => item.name === "close_user")?.discriminator ?? [];
}

function instructionIsCloseUser(tx: HistoryTransaction, program: PublicKey): boolean {
  const message = tx.transaction?.message;
  if (!message) return false;
  const keys = message.staticAccountKeys ?? message.accountKeys ?? [];
  const instructions = message.compiledInstructions ?? message.instructions ?? [];
  const disc = closeUserDiscriminator();
  if (disc.length !== 8) return false;
  const want = program.toBase58();
  for (const ix of instructions) {
    if (programKey(keys[ix.programIdIndex]) !== want) continue;
    const data = instructionBytes(ix.data);
    if (!data || data.length < 8) continue;
    if (disc.every((byte, index) => data[index] === byte)) return true;
  }
  return false;
}

/**
 * Successful close of this owner's account. A failed transaction, including
 * a failed close, does not count. Signatures are already the owner's account.
 */
export function closeMarkFromTransaction(
  tx: HistoryTransaction | null,
  signature: string,
  program: PublicKey,
): CloseMark | null {
  if (!tx || tx.meta?.err != null) return null;
  const logs = tx.meta?.logMessages ?? [];
  if (!logsContainCloseUser(logs, program) && !instructionIsCloseUser(tx, program)) return null;
  const slot = typeof tx.slot === "number" ? tx.slot : 0;
  if (slot <= 0) return null;
  const ts = typeof tx.blockTime === "number" ? tx.blockTime : 0;
  return { slot, ts, signature };
}

export type HistoryPage = {
  entries: HistoryEntry[];
  closes: CloseMark[];
  exhausted: boolean;
  oldest: string | null;
  /**
   * Cursor to store. The newest signature when every getTransaction on this
   * page succeeded (an empty buy list still counts). When any read is null,
   * this is the previous cursor (`until`, or null) so the next poll retries
   * the hole instead of stepping past it.
   */
  newest: string | null;
  /** Transactions actually requested. A cache hit is not a request. */
  fetched: number;
};

/**
 * Cursor after one page. Signatures are newest-first.
 * `read` holds signatures whose getTransaction returned a transaction,
 * including ones that were already cached and ones that yielded no buys.
 * A null read anywhere keeps `previous`, so `until` cannot jump the gap.
 * When the page is complete, the cursor is the newest signature.
 */
export function committedHistoryNewest(
  signatures: readonly string[],
  read: ReadonlySet<string>,
  previous: string | null,
): string | null {
  if (signatures.length === 0) return previous;
  for (const signature of signatures) {
    if (!read.has(signature)) return previous;
  }
  return signatures[0] ?? previous;
}

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
  /** Stop at this signature. Incremental refresh passes the newest one already stored. */
  until?: string;
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
          ...(args.until ? { until: args.until } : {}),
        }),
        timeoutMs,
        "history-sigs",
      ),
    args.cap ?? HISTORY_INITIAL_SIGNATURE_CAP,
    HISTORY_PAGE_SIZE,
    args.before,
  );
  const missing = signatures.filter((signature) => !(signature in cache.entries));
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
      const tx = txs[index] ?? null;
      // A timeout or a missing transaction is not a successful read.
      if (tx == null) return;
      const close = closeMarkFromTransaction(tx, signature, args.programId);
      if (close) cache.closes[signature] = { slot: close.slot, ts: close.ts ?? 0 };
      else delete cache.closes[signature];
      cache.entries[signature] = entriesFromTransaction(tx, signature, args.owner, args.programId);
    });
  }
  writeHistoryCache(args.storage ?? null, args.owner, cache);
  const entries: HistoryEntry[] = [];
  const closes: CloseMark[] = [];
  const read = new Set<string>();
  for (const signature of signatures) {
    entries.push(...(cache.entries[signature] ?? []));
    if (signature in cache.entries) read.add(signature);
    const mark = cache.closes[signature];
    if (mark) closes.push({ signature, slot: mark.slot, ts: mark.ts });
  }
  return {
    entries,
    closes,
    exhausted,
    oldest,
    newest: committedHistoryNewest(signatures, read, args.until ?? null),
    fetched,
  };
}

/** Visible tab and no refresh already running. Hidden or busy → skip. */
export function historyRefreshDecision(input: { visible: boolean; inFlight: boolean }): "poll" | "skip" {
  if (!input.visible || input.inFlight) return "skip";
  return "poll";
}

export type HistoryCursor = {
  owner: string | null;
  newest: string | null;
};

/**
 * Poll and a just-confirmed buy stay off while the cursor has no owner.
 * close_user clears it. The gap until the next initialize_user stays quiet.
 */
export function historyReadsArmed(cursor: Pick<HistoryCursor, "owner">, owner: string | null): boolean {
  return owner != null && cursor.owner === owner;
}

/**
 * Same wallet, cursor cleared by close, UserConfig exists again.
 * The owner effect does not re-run, so this is the signal to load history.
 * Onboarding (account not ready) stays false and the poll does not start.
 */
export function shouldReloadHistoryAfterInit(input: {
  cursorOwner: string | null;
  ownerKey: string | null;
  accountReady: boolean;
}): boolean {
  if (!input.ownerKey || !input.accountReady) return false;
  return input.cursorOwner !== input.ownerKey;
}

/**
 * Incremental signature query. `until` is the newest signature already stored,
 * so the RPC returns only newer ones. Without it, the first load uses the cap.
 */
export function historyIncrementalQuery(newest: string | null | undefined): {
  until?: string;
  cap: number;
} {
  if (newest) return { until: newest, cap: HISTORY_INITIAL_SIGNATURE_CAP };
  return { cap: HISTORY_INITIAL_SIGNATURE_CAP };
}

/** Serializes history reads so a poll cannot overlap a purchase refresh. */
export function createHistoryRefreshQueue(): {
  readonly inFlight: boolean;
  enqueue(job: () => Promise<void>): Promise<void>;
} {
  let tail: Promise<void> = Promise.resolve();
  let active = 0;
  return {
    get inFlight() {
      return active > 0;
    },
    enqueue(job) {
      const run = tail.then(async () => {
        active += 1;
        try {
          await job();
        } finally {
          active -= 1;
        }
      });
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
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
