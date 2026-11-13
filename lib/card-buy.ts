/**
 * Card-mode manual buy. One index from the card, one mismatch retry, then stop.
 * Confirmation is the card (or an already confirmed signature), never a RunRecord.
 */

import { ORIGIN_MANUAL, type UserCard } from "@/lib/user-config";

export const ZERO_SIGNATURE_HASH = new Uint8Array(32);

/** `simulate_buy_v3` accounts in IDL order. No run record and no run price. */
export const SIMULATE_BUY_V3_ACCOUNT_ORDER = [
  "owner",
  "userConfig",
  "usdcMint",
  "vault",
  "mintAuth",
  "mintA",
  "mintB",
  "mintC",
  "ownerAtaA",
  "ownerAtaB",
  "ownerAtaC",
  "priceFeedA",
  "priceFeedB",
  "priceFeedC",
  "tokenProgram",
  "associatedTokenProgram",
  "systemProgram",
] as const;

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Submit `firstIndex`. On a run-index mismatch, read the card once and submit
 * that new index once. A second mismatch throws `mismatchMessage`. No loop.
 */
export async function retryCardBuy(args: {
  firstIndex: number;
  rereadIndex: () => Promise<number>;
  submit: (index: number) => Promise<string>;
  isMismatch: (err: unknown) => boolean;
  mismatchMessage: string;
}): Promise<string> {
  try {
    return await args.submit(args.firstIndex);
  } catch (err) {
    if (!args.isMismatch(err)) throw err;
  }
  const second = await args.rereadIndex();
  try {
    return await args.submit(second);
  } catch (err) {
    if (args.isMismatch(err)) throw new Error(args.mismatchMessage);
    throw err;
  }
}

/**
 * The purchase landed when the card's last run is the index we sent,
 * the origin is manual (2), and the signature hash matches what we sent.
 * A confirmed transaction signature is enough on its own.
 */
export function cardBuyConfirmed(input: {
  expectedRunIndex: number;
  card: Pick<UserCard, "hasLastRun" | "lastRunIndex" | "lastOrigin" | "lastSignatureHash"> | null;
  sentSignatureHash: Uint8Array;
  signatureConfirmed?: boolean;
}): boolean {
  if (input.signatureConfirmed) return true;
  const card = input.card;
  if (!card || !card.hasLastRun) return false;
  const last = Number(card.lastRunIndex.toString());
  if (last !== input.expectedRunIndex) return false;
  if (card.lastOrigin !== ORIGIN_MANUAL) return false;
  return bytesEqual(card.lastSignatureHash, input.sentSignatureHash);
}
