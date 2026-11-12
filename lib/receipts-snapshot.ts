/**
 * Static receipt dump. One fetch per session. A placeholder, a bad checksum,
 * an unknown version, or any read error drops the source. Console only.
 */

import { appBasePath } from "@/lib/runtime-config";
import {
  mergeHistory,
  originFromFeePayer,
  type HistoryEntry,
} from "@/lib/history-entry";

export const RECEIPT_SNAPSHOT_VERSION = 1;
export const RECEIPT_SNAPSHOT_NAME = "receipts-snapshot-devnet.json";

export type ReceiptType = "RunRecord" | "RunPrice";

export type ReceiptRow = {
  type: ReceiptType;
  pubkey: string;
  owner: string;
  run_index: number;
  mints?: string[];
  amounts?: Array<number | string>;
  signature_hash?: number[];
  slot?: number;
  ts?: number;
  prices?: Array<number | string>;
  price_decimals?: number[];
  price_ts?: Array<number | string>;
  usdc_spent_each?: number | string;
  lamports?: number;
  firstSignature?: string;
  firstFeePayer?: string;
};

export type ReceiptSnapshotFile = {
  version: number;
  cluster?: string;
  programId?: string;
  createdAt?: string;
  slot?: number;
  count?: number;
  placeholder?: boolean;
  receipts: ReceiptRow[];
};

let sessionLoad: Promise<ReceiptSnapshotFile | null> | null = null;

export function resetReceiptSnapshotForTests(): void {
  sessionLoad = null;
}

export function snapshotUrl(basePath = appBasePath()): string {
  const base = basePath.replace(/\/$/, "");
  return `${base}/data/${RECEIPT_SNAPSHOT_NAME}`;
}

export function snapshotShaUrl(basePath = appBasePath()): string {
  return `${snapshotUrl(basePath)}.sha256`;
}

/** First whitespace-separated field, compared case-insensitively. */
export function sha256Field(text: string): string {
  const field = text.trim().split(/\s+/)[0] ?? "";
  return field.toLowerCase();
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function asBigint(value: number | string | undefined): bigint {
  if (value == null) return BigInt(0);
  try {
    return BigInt(value);
  } catch {
    return BigInt(0);
  }
}

function isReceiptType(value: unknown): value is ReceiptType {
  return value === "RunRecord" || value === "RunPrice";
}

/** Unknown version, placeholder, or a bad shape → skip. */
export function validateReceiptSnapshot(raw: unknown): ReceiptSnapshotFile | null {
  if (!raw || typeof raw !== "object") return null;
  const file = raw as Partial<ReceiptSnapshotFile>;
  if (file.version !== RECEIPT_SNAPSHOT_VERSION) return null;
  if (file.placeholder === true) return null;
  if (!Array.isArray(file.receipts)) return null;
  const receipts: ReceiptRow[] = [];
  for (const row of file.receipts) {
    if (!row || typeof row !== "object") return null;
    const item = row as Partial<ReceiptRow>;
    if (!isReceiptType(item.type)) return null;
    if (typeof item.owner !== "string" || typeof item.run_index !== "number") return null;
    receipts.push(item as ReceiptRow);
  }
  return {
    version: RECEIPT_SNAPSHOT_VERSION,
    cluster: typeof file.cluster === "string" ? file.cluster : undefined,
    programId: typeof file.programId === "string" ? file.programId : undefined,
    createdAt: typeof file.createdAt === "string" ? file.createdAt : undefined,
    slot: typeof file.slot === "number" ? file.slot : undefined,
    count: typeof file.count === "number" ? file.count : receipts.length,
    receipts,
  };
}

/**
 * RunRecord and RunPrice that share `run_index` become one purchase.
 * Origin is manual when the first fee payer is the owner.
 */
export function entriesFromSnapshot(file: ReceiptSnapshotFile, owner: string): HistoryEntry[] {
  const groups = new Map<number, { record?: ReceiptRow; price?: ReceiptRow }>();
  for (const row of file.receipts) {
    if (row.owner !== owner) continue;
    const bucket = groups.get(row.run_index) ?? {};
    if (row.type === "RunRecord") bucket.record = row;
    else bucket.price = row;
    groups.set(row.run_index, bucket);
  }
  const entries: HistoryEntry[] = [];
  for (const [runIndex, pair] of groups) {
    const record = pair.record;
    const price = pair.price;
    const base = record ?? price;
    if (!base) continue;
    const feePayer = record?.firstFeePayer ?? price?.firstFeePayer ?? null;
    const mints = (record?.mints ?? price?.mints ?? []).map(String);
    const amounts = (record?.amounts ?? []).map((amount) => asBigint(amount));
    const prices = price?.prices?.map((value) => asBigint(value));
    entries.push({
      runIndex,
      origin: originFromFeePayer(feePayer, owner),
      mints,
      amounts,
      prices,
      priceDecimals: price?.price_decimals ? [...price.price_decimals] : undefined,
      priceTs: price?.price_ts?.map((value) => asBigint(value)),
      usdcEach: asBigint(price?.usdc_spent_each),
      signature: record?.firstSignature ?? price?.firstSignature ?? "",
      slot: record?.slot ?? price?.slot ?? 0,
      ts: record?.ts ?? price?.ts ?? 0,
      source: "snapshot",
      priceKnown: prices != null && prices.some((value) => value > BigInt(0)),
      priceMissing: !(prices != null && prices.some((value) => value > BigInt(0))),
    });
  }
  return mergeHistory([entries]);
}

function warnSkip(reason: string): void {
  console.warn(`receipt snapshot skipped: ${reason}`);
}

/**
 * Fetch the JSON and its `.sha256` once per session. Bytes are hashed with
 * WebCrypto and compared to the first field of the checksum file.
 */
export async function loadReceiptSnapshot(opts?: {
  fetchImpl?: typeof fetch;
  basePath?: string;
  force?: boolean;
}): Promise<ReceiptSnapshotFile | null> {
  if (opts?.force) sessionLoad = null;
  if (!sessionLoad) {
    const fetchImpl = opts?.fetchImpl ?? fetch;
    const basePath = opts?.basePath;
    sessionLoad = readSnapshot(fetchImpl, basePath).catch((err: unknown) => {
      warnSkip(err instanceof Error ? err.message : "read");
      return null;
    });
  }
  return sessionLoad;
}

async function readSnapshot(
  fetchImpl: typeof fetch,
  basePath: string | undefined,
): Promise<ReceiptSnapshotFile | null> {
  const jsonUrl = snapshotUrl(basePath);
  const shaUrl = snapshotShaUrl(basePath);
  const [jsonResp, shaResp] = await Promise.all([
    fetchImpl(jsonUrl, { cache: "no-cache" }),
    fetchImpl(shaUrl, { cache: "no-cache" }),
  ]);
  if (!jsonResp.ok || !shaResp.ok) {
    warnSkip("http");
    return null;
  }
  const bytes = new Uint8Array(await jsonResp.arrayBuffer());
  const expected = sha256Field(await shaResp.text());
  const actual = await sha256Hex(bytes);
  if (!expected || actual !== expected) {
    warnSkip("sha256");
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    warnSkip("json");
    return null;
  }
  if (raw && typeof raw === "object" && (raw as { placeholder?: boolean }).placeholder === true) {
    warnSkip("placeholder");
    return null;
  }
  if (raw && typeof raw === "object" && (raw as { version?: unknown }).version !== RECEIPT_SNAPSHOT_VERSION) {
    warnSkip("version");
    return null;
  }
  const file = validateReceiptSnapshot(raw);
  if (!file) {
    warnSkip("invalid");
    return null;
  }
  return file;
}

export async function receiptEntriesForOwner(
  owner: string,
  opts?: { fetchImpl?: typeof fetch; basePath?: string },
): Promise<HistoryEntry[]> {
  const file = await loadReceiptSnapshot(opts);
  if (!file) return [];
  return entriesFromSnapshot(file, owner);
}
