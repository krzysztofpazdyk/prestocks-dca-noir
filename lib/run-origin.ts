/**
 * A RunRecord has no auto/manual field. The account's oldest transaction
 * does: keeper execute_buy* is auto, owner simulate_buy* or record_run is manual.
 * The label never changes, so a hit is stored per owner and run index.
 * An RPC failure leaves the line unchanged.
 */

import { BN, utils } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import idl from "@/idl/predca.json";
import { translate, type Locale } from "@/lib/i18n";
import { programId, runRecordPda } from "@/lib/predca";
import { RPC_READ_TIMEOUT_MS, withTimeout } from "@/lib/rpc-timeout";

export type RunOrigin = "auto" | "manual";

export type RunOriginLoad =
  | { ok: true; origin: RunOrigin | null }
  | { ok: false };

const DISC_LEN = 8;
const SIGNATURE_PAGE_SIZE = 1000;
const MAX_SIGNATURE_PAGES = 32;

export const RUN_ORIGIN_LS_PREFIX = "noir3.runOrigin";

type IdlInstruction = { name: string; discriminator: number[] };

function originForInstructionName(name: string): RunOrigin | null {
  if (name.startsWith("execute_buy")) return "auto";
  if (name.startsWith("simulate_buy") || name === "record_run") return "manual";
  return null;
}

function discKey(data: ArrayLike<number>): string | null {
  if (data.length < DISC_LEN) return null;
  let key = "";
  for (let i = 0; i < DISC_LEN; i += 1) {
    const byte = data[i] ?? -1;
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) return null;
    key += byte.toString(16).padStart(2, "0");
  }
  return key;
}

const ORIGIN_BY_DISC = new Map<string, RunOrigin>();

for (const ix of idl.instructions as IdlInstruction[]) {
  const origin = originForInstructionName(ix.name);
  if (!origin || !Array.isArray(ix.discriminator)) continue;
  const key = discKey(ix.discriminator);
  if (!key) continue;
  if (ORIGIN_BY_DISC.get(key) === "auto") continue;
  ORIGIN_BY_DISC.set(key, origin);
}

/** execute_buy* → auto, simulate_buy* and record_run → manual. Anything else is unlabeled. */
export function classifyBuyDiscriminator(data: ArrayLike<number>): RunOrigin | null {
  const key = discKey(data);
  if (!key) return null;
  return ORIGIN_BY_DISC.get(key) ?? null;
}

/** execute_buy* wins when the same transaction also records the run. */
export function classifyBuyDiscriminators(
  datas: Array<ArrayLike<number>>,
): RunOrigin | null {
  let manual = false;
  for (const data of datas) {
    const origin = classifyBuyDiscriminator(data);
    if (origin === "auto") return "auto";
    if (origin === "manual") manual = true;
  }
  return manual ? "manual" : null;
}

type OriginKey = { toBase58(): string } | string;

type OriginInstruction = {
  programIdIndex: number;
  data?: Uint8Array | number[] | string;
};

export type OriginTransaction = {
  transaction: {
    message: {
      accountKeys?: OriginKey[];
      staticAccountKeys?: OriginKey[];
      instructions?: OriginInstruction[];
      compiledInstructions?: OriginInstruction[];
    };
  };
  meta?: {
    loadedAddresses?: {
      writable?: OriginKey[];
      readonly?: OriginKey[];
    } | null;
    innerInstructions?: Array<{ instructions?: OriginInstruction[] }> | null;
  } | null;
};

function keyBase58(key: OriginKey): string {
  return typeof key === "string" ? key : key.toBase58();
}

function asBytes(data: Uint8Array | number[] | string): Uint8Array | null {
  if (typeof data === "string") {
    try {
      const decoded = utils.bytes.bs58.decode(data);
      return decoded instanceof Uint8Array
        ? decoded
        : Uint8Array.from(decoded as ArrayLike<number>);
    } catch {
      return null;
    }
  }
  if (data instanceof Uint8Array) return data;
  if (data.every((byte) => typeof byte === "number")) return Uint8Array.from(data);
  return null;
}

function accountKeysOf(tx: OriginTransaction): string[] {
  const message = tx.transaction.message;
  const staticKeys =
    message.staticAccountKeys && message.staticAccountKeys.length > 0
      ? message.staticAccountKeys
      : (message.accountKeys ?? []);
  const loaded = tx.meta?.loadedAddresses;
  return [...staticKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])].map(
    keyBase58,
  );
}

function instructionGroups(tx: OriginTransaction): OriginInstruction[] {
  const message = tx.transaction.message;
  const outer = message.compiledInstructions ?? message.instructions ?? [];
  const inner = (tx.meta?.innerInstructions ?? []).flatMap(
    (group) => group.instructions ?? [],
  );
  return [...outer, ...inner];
}

/** Instruction payloads of `programAddress`, outer first, then inner. */
export function predcaInstructionData(
  tx: OriginTransaction,
  programAddress: string,
): Uint8Array[] {
  const keys = accountKeysOf(tx);
  const out: Uint8Array[] = [];
  for (const ix of instructionGroups(tx)) {
    if (keys[ix.programIdIndex] !== programAddress) continue;
    if (ix.data == null) continue;
    const bytes = asBytes(ix.data);
    if (bytes) out.push(bytes);
  }
  return out;
}

export function classifyRunTransaction(
  tx: OriginTransaction,
  programAddress: string,
): RunOrigin | null {
  return classifyBuyDiscriminators(predcaInstructionData(tx, programAddress));
}

export function appendRunOrigin(
  line: string,
  locale: Locale,
  origin: RunOrigin | null,
): string {
  if (origin !== "auto" && origin !== "manual") return line;
  const word = translate(
    locale,
    origin === "auto" ? "history.origin.auto" : "history.origin.manual",
  );
  return `${line} · ${word}`;
}

/** History run line. `budgetText` null uses the unknown-price template. No origin → no suffix. */
export function historyRunMetaText(input: {
  locale: Locale;
  index: string;
  slot: string;
  budgetText: string | null;
  origin: RunOrigin | null;
}): string {
  const base =
    input.budgetText == null
      ? translate(input.locale, "history.runMetaUnknown", {
          index: input.index,
          unknown: translate(input.locale, "runPrice.unknown"),
          slot: input.slot,
        })
      : translate(input.locale, "history.runMeta", {
          index: input.index,
          budget: input.budgetText,
          slot: input.slot,
        });
  return appendRunOrigin(base, input.locale, input.origin);
}

export function runOriginStorageKey(owner: string, runIndex: string): string {
  return `${RUN_ORIGIN_LS_PREFIX}.${owner}.${runIndex}`;
}

export function runOriginStorage(): Storage | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
    if (typeof globalThis.localStorage !== "undefined") return globalThis.localStorage;
  } catch {
    return null;
  }
  return null;
}

const originListeners = new Set<() => void>();

export function subscribeRunOriginCache(listener: () => void): () => void {
  originListeners.add(listener);
  return () => {
    originListeners.delete(listener);
  };
}

function emitRunOriginCache(): void {
  for (const listener of originListeners) listener();
}

/** Cached labels for the runs in `runIndexKey`, as `index=auto,index=manual`. */
export function readRunOriginSnapshot(owner: string | null, runIndexKey: string): string {
  if (!owner) return "";
  const storage = runOriginStorage();
  if (!storage) return "";
  const parts: string[] = [];
  for (const index of runIndexKey.split(",")) {
    if (!index) continue;
    const origin = readRunOriginCache(storage, owner, index);
    if (origin) parts.push(`${index}=${origin}`);
  }
  return parts.join(",");
}

export function originsFromSnapshot(snapshot: string): Record<string, RunOrigin> {
  const out: Record<string, RunOrigin> = {};
  for (const part of snapshot.split(",")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const index = part.slice(0, eq);
    const origin = part.slice(eq + 1);
    if (origin === "auto" || origin === "manual") out[index] = origin;
  }
  return out;
}

export function readRunOriginCache(
  storage: Storage,
  owner: string,
  runIndex: string,
): RunOrigin | null {
  try {
    const value = storage.getItem(runOriginStorageKey(owner, runIndex));
    if (value === "auto" || value === "manual") return value;
  } catch {
    return null;
  }
  return null;
}

export function writeRunOriginCache(
  storage: Storage,
  owner: string,
  runIndex: string,
  origin: RunOrigin,
): void {
  try {
    const key = runOriginStorageKey(owner, runIndex);
    if (storage.getItem(key) === origin) return;
    storage.setItem(key, origin);
  } catch {
    return;
  }
  emitRunOriginCache();
}

/**
 * Newest-first pages. Returns the oldest signature, or null when the scan
 * cannot be finished (empty account or a page cap).
 */
export async function oldestSignature(
  fetchPage: (before?: string) => Promise<ReadonlyArray<{ signature: string }>>,
  pageSize = SIGNATURE_PAGE_SIZE,
): Promise<string | null> {
  let before: string | undefined;
  let oldest: string | null = null;
  for (let page = 0; page < MAX_SIGNATURE_PAGES; page += 1) {
    const sigs = await fetchPage(before);
    if (!Array.isArray(sigs) || sigs.length === 0) break;
    const last = sigs[sigs.length - 1]?.signature;
    if (!last) break;
    oldest = last;
    if (sigs.length < pageSize) return oldest;
    if (last === before) return null;
    if (page === MAX_SIGNATURE_PAGES - 1) return null;
    before = last;
  }
  return oldest;
}

export type OriginConnection = {
  getSignaturesForAddress(
    address: PublicKey,
    options?: { before?: string; limit?: number },
  ): Promise<ReadonlyArray<{ signature: string }>>;
  getTransaction(
    signature: string,
    options?: { commitment?: "confirmed"; maxSupportedTransactionVersion?: number },
  ): Promise<OriginTransaction | null>;
};

function toRunIndex(runIndex: number | string | BN): BN {
  if (BN.isBN(runIndex)) return runIndex;
  if (typeof runIndex === "number") {
    if (!Number.isSafeInteger(runIndex) || runIndex < 0) {
      throw new Error("bad run index");
    }
    return new BN(runIndex);
  }
  if (!/^\d+$/.test(runIndex)) throw new Error("bad run index");
  return new BN(runIndex, 10);
}

/**
 * Oldest signature on PDA ("run", owner, run_index), then the Predca
 * discriminator in that transaction. RPC errors are `{ ok: false }`.
 */
export async function loadRunOrigin(
  connection: OriginConnection,
  owner: PublicKey,
  runIndex: number | string | BN,
): Promise<RunOriginLoad> {
  try {
    const program = programId();
    const [pda] = runRecordPda(owner, toRunIndex(runIndex));
    const signature = await withTimeout(
      oldestSignature((before) =>
        connection.getSignaturesForAddress(pda, {
          limit: SIGNATURE_PAGE_SIZE,
          ...(before ? { before } : {}),
        }),
      ),
      RPC_READ_TIMEOUT_MS,
      "run-origin-sigs",
    );
    if (!signature) return { ok: false };
    const tx = await withTimeout(
      connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      }),
      RPC_READ_TIMEOUT_MS,
      "run-origin-tx",
    );
    if (!tx) return { ok: false };
    return { ok: true, origin: classifyRunTransaction(tx, program.toBase58()) };
  } catch {
    return { ok: false };
  }
}
