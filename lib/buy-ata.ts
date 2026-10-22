import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { translate } from "@/lib/i18n";
import { getLocaleSnapshot, type Locale } from "@/lib/locale-store";
import { isRateOrNetworkError, parseAnchorError } from "@/lib/predca";
import { withTimeout } from "@/lib/rpc-timeout";

/** Legacy transaction packet limit, including the signature slot. */
export const LEGACY_TX_PACKET_BYTES = 1232;

export const SIGNATURE_POLL_INTERVAL_MS = 1500;
export const SIGNATURE_POLL_TIMEOUT_MS = 60_000;
/** One status read. A hang counts as "still pending", same as any other read error. */
export const SIGNATURE_STATUS_READ_TIMEOUT_MS = 10_000;

export type BuySubmitPlan = "buy-only" | "combined" | "two-step";

export type SignatureStatusRow = {
  err: unknown;
  confirmationStatus: string | null;
} | null;

/**
 * Timeout that `isUnconfirmedTimeout` already understands.
 * The name and the "was not confirmed" sentence are deliberate: a purchase
 * that was broadcast must stay tracked, and must not be sent again.
 * Do not use this for a token-account transaction. That signature is not the buy.
 */
export class SignatureNotConfirmedError extends Error {
  readonly signature: string;

  constructor(signature: string, timeoutMs: number) {
    super(
      `Transaction was not confirmed in ${timeoutMs}ms. It is unknown if it succeeded or failed. Check signature ${signature} using the Solana Explorer or CLI tools.`,
    );
    this.name = "TransactionExpiredTimeoutError";
    this.signature = signature;
  }
}

export function ownerAtaAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID);
}

/** Indexes whose account is absent. `true` means the account already exists. */
export function missingAtaIndexes(exists: ReadonlyArray<boolean>): number[] {
  const missing: number[] = [];
  for (let i = 0; i < exists.length; i++) {
    if (!exists[i]) missing.push(i);
  }
  return missing;
}

/** Idempotent creates for the missing indexes only, in that same order. */
export function ataCreateInstructions(
  owner: PublicKey,
  mints: readonly PublicKey[],
  missingIndexes: readonly number[],
): TransactionInstruction[] {
  const instructions: TransactionInstruction[] = [];
  for (const index of missingIndexes) {
    const mint = mints[index];
    if (!mint) continue;
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        ownerAtaAddress(owner, mint),
        owner,
        mint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
  }
  return instructions;
}

export function transactionFromInstructions(
  instructions: readonly TransactionInstruction[],
  feePayer: PublicKey,
  recentBlockhash: string,
): Transaction {
  const tx = new Transaction();
  for (const ix of instructions) tx.add(ix);
  tx.feePayer = feePayer;
  tx.recentBlockhash = recentBlockhash;
  return tx;
}

/** Token-account creates first, then the purchase. One fee payer, one signature. */
export function assembleBuyTransaction(
  ataInstructions: readonly TransactionInstruction[],
  buyInstruction: TransactionInstruction,
  feePayer: PublicKey,
  recentBlockhash: string,
): Transaction {
  return transactionFromInstructions(
    [...ataInstructions, buyInstruction],
    feePayer,
    recentBlockhash,
  );
}

/** Byte length the cluster will accept or reject. Includes the signature slot. */
export function legacyPacketBytes(tx: Transaction): number {
  return tx.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  }).length;
}

/**
 * One signature when every missing account fits in front of the purchase.
 * Otherwise the accounts go out first and the purchase waits for them.
 */
export function chooseBuySubmit(
  missingCount: number,
  serializedBytes: number,
): BuySubmitPlan {
  if (missingCount <= 0) return "buy-only";
  if (
    Number.isFinite(serializedBytes) &&
    serializedBytes > 0 &&
    serializedBytes <= LEGACY_TX_PACKET_BYTES
  ) {
    return "combined";
  }
  return "two-step";
}

export function classifySignatureRow(
  row: SignatureStatusRow,
): "pending" | "confirmed" | "failed" {
  if (row == null) return "pending";
  if (row.err) return "failed";
  if (
    row.confirmationStatus === "confirmed" ||
    row.confirmationStatus === "finalized"
  ) {
    return "confirmed";
  }
  return "pending";
}

/**
 * On-chain rejection. `onChainReject` is how the app recognizes it.
 * The Polish sentence stays only as a fallback for messages saved earlier.
 */
export class SignatureFailedError extends Error {
  readonly signature: string;
  readonly onChainReject = true;

  constructor(signature: string, message: string) {
    super(message);
    this.name = "SignatureFailedError";
    this.signature = signature;
  }
}

/** Readable Anchor reason from logs, or null when the logs name no known error. */
export function reasonFromAnchorLogs(logs: readonly string[]): string | null {
  const lines = logs.map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) return null;
  const parsed = parseAnchorError({ logs: lines, message: "" }).trim();
  return parsed.length > 0 ? parsed : null;
}

export function signatureFailedMessage(
  signature: string,
  reason?: string | null,
  locale?: Locale,
): string {
  const clean = reason?.replace(/\s+/g, " ").trim() ?? "";
  if (clean.length > 0) {
    return clean.includes(signature) ? clean : `${clean} ${signature}`;
  }
  return translate(locale ?? getLocaleSnapshot(), "tx.err.rejected", { signature });
}

export function signatureFailedError(
  signature: string,
  reason?: string | null,
  locale?: Locale,
): SignatureFailedError {
  return new SignatureFailedError(
    signature,
    signatureFailedMessage(signature, reason, locale),
  );
}

export type SignaturePollOptions = {
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** One `getSignatureStatuses` read. Default 10s. A timeout is "still pending". */
  statusTimeoutMs?: number;
  /**
   * One read of logs after the signature lands with `err`.
   * A throw, null, or no recognized reason keeps the fallback message.
   * This does not send the transaction again.
   */
  readLogs?: (signature: string) => Promise<readonly string[] | null | undefined>;
};

/** One pause, then a second read. Anything already sent must not use this. */
export const ACCOUNT_LOOKUP_RETRY_MS = 400;

export async function withOneNetworkRetry<T>(
  read: () => Promise<T>,
  opts?: {
    sleep?: (ms: number) => Promise<void>;
    pauseMs?: number;
  },
): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (!isRateOrNetworkError(err)) throw err;
    const sleep = opts?.sleep ?? defaultSleep;
    await sleep(opts?.pauseMs ?? ACCOUNT_LOOKUP_RETRY_MS);
    return await read();
  }
}

/**
 * Confirm without a websocket. `getStatuses` is `getSignatureStatuses`.
 * The transaction is already sent. Every status-read error, including a
 * timeout on that one read, counts as "still pending". The loop keeps going
 * until the time limit, then always throws `SignatureNotConfirmedError`
 * (tracked signature). A landed `err` throws `SignatureFailedError` and
 * does not send again.
 */
export async function confirmSignatureByPolling(
  getStatuses: (signature: string) => Promise<ReadonlyArray<SignatureStatusRow>>,
  signature: string,
  options: SignaturePollOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? SIGNATURE_POLL_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? SIGNATURE_POLL_INTERVAL_MS;
  const statusTimeoutMs =
    options.statusTimeoutMs ?? SIGNATURE_STATUS_READ_TIMEOUT_MS;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const readLogs = options.readLogs;
  const started = now();
  for (;;) {
    let rows: ReadonlyArray<SignatureStatusRow> | null = null;
    const remaining = timeoutMs - (now() - started);
    const readBudget = Math.max(
      0,
      Math.min(statusTimeoutMs, Number.isFinite(remaining) ? remaining : 0),
    );
    try {
      rows = await withTimeout(
        Promise.resolve(getStatuses(signature)),
        readBudget,
        "getSignatureStatuses",
      );
    } catch {
      // 500, JSON-RPC "Internal error", a dropped connection, or a hung read.
      rows = null;
    }
    const kind = classifySignatureRow(rows?.[0] ?? null);
    if (kind === "confirmed") return;
    if (kind === "failed") throw await errorForFailedSignature(signature, readLogs);
    const elapsed = now() - started;
    if (elapsed >= timeoutMs) {
      throw new SignatureNotConfirmedError(signature, timeoutMs);
    }
    const wait = Math.min(intervalMs, timeoutMs - elapsed);
    await sleep(wait);
  }
}

async function errorForFailedSignature(
  signature: string,
  readLogs: SignaturePollOptions["readLogs"],
): Promise<SignatureFailedError> {
  if (!readLogs) return signatureFailedError(signature);
  try {
    const logs = await readLogs(signature);
    if (!logs || logs.length === 0) return signatureFailedError(signature);
    return signatureFailedError(signature, reasonFromAnchorLogs(logs));
  } catch {
    return signatureFailedError(signature);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
