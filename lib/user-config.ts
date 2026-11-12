/**
 * Raw UserConfig decoder. Anchor `account.userConfig.fetch*` follows the new
 * 305-byte IDL and cannot read a 59-byte account, so every read goes through
 * these bytes. Old fields keep their offsets. New fields start at byte 59.
 */

import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

/** sha256("account:UserConfig")[0..8], unchanged across the 59 → 305 growth. */
export const USER_CONFIG_DISC = Uint8Array.from([
  58, 201, 49, 59, 232, 236, 180, 75,
]);

export const LEGACY_USER_CONFIG_LEN = 59;
export const CARD_USER_CONFIG_LEN = 305;
export const CARD_VERSION = 1;

/** 1 = automatic purchase, 2 = manual purchase. */
export const ORIGIN_AUTO = 1;
export const ORIGIN_MANUAL = 2;

export class UserConfigDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserConfigDecodeError";
  }
}

export type UserCard = {
  cardVersion: number;
  hasLastRun: boolean;
  lastRunIndex: BN;
  lastBuyTs: BN;
  lastSlot: BN;
  lastMints: PublicKey[];
  lastAmounts: BN[];
  lastPrices: BN[];
  lastPriceDecimals: number[];
  lastPriceTs: BN[];
  lastUsdcEach: BN;
  lastFeeUsdc: BN;
  lastSignatureHash: Uint8Array;
  /** 1 = auto, 2 = manual. */
  lastOrigin: number;
};

export type DecodedUserConfig = {
  size: number;
  legacy: boolean;
  owner: PublicKey;
  weeklyBudgetUsdc: BN;
  excludeFlags: number;
  lastRunTs: BN;
  bump: number;
  vaultBump: number;
  card?: UserCard;
};

function viewOf(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function readU64(data: Uint8Array, off: number): BN {
  return new BN(viewOf(data).getBigUint64(off, true).toString());
}

function readI64(data: Uint8Array, off: number): BN {
  return new BN(viewOf(data).getBigInt64(off, true).toString());
}

function readPubkey(data: Uint8Array, off: number): PublicKey {
  return new PublicKey(data.subarray(off, off + 32));
}

function assertDisc(data: Uint8Array): void {
  if (data.length < USER_CONFIG_DISC.length) {
    throw new UserConfigDecodeError(`UserConfig size ${data.length}`);
  }
  for (let i = 0; i < USER_CONFIG_DISC.length; i++) {
    if (data[i] !== USER_CONFIG_DISC[i]) {
      throw new UserConfigDecodeError("UserConfig discriminator mismatch");
    }
  }
}

/**
 * 59 bytes → legacy. 305 bytes with `card_version == 1` → card.
 * Any other length throws. A 305-byte account with another card version throws.
 */
export function decodeUserConfig(data: Uint8Array): DecodedUserConfig {
  if (data.length !== LEGACY_USER_CONFIG_LEN && data.length !== CARD_USER_CONFIG_LEN) {
    throw new UserConfigDecodeError(`UserConfig size ${data.length}`);
  }
  assertDisc(data);
  let off = 8;
  const owner = readPubkey(data, off);
  off += 32;
  const weeklyBudgetUsdc = readU64(data, off);
  off += 8;
  const excludeFlags = data[off];
  off += 1;
  const lastRunTs = readI64(data, off);
  off += 8;
  const bump = data[off];
  off += 1;
  const vaultBump = data[off];
  off += 1;
  const base = {
    size: data.length,
    legacy: data.length === LEGACY_USER_CONFIG_LEN,
    owner,
    weeklyBudgetUsdc,
    excludeFlags,
    lastRunTs,
    bump,
    vaultBump,
  };
  if (data.length === LEGACY_USER_CONFIG_LEN) return base;

  const cardVersion = data[off];
  off += 1;
  if (cardVersion !== CARD_VERSION) {
    throw new UserConfigDecodeError(`UserConfig card_version ${cardVersion}`);
  }
  const hasLastRun = data[off] !== 0;
  off += 1;
  const lastRunIndex = readU64(data, off);
  off += 8;
  const lastBuyTs = readI64(data, off);
  off += 8;
  const lastSlot = readU64(data, off);
  off += 8;
  const lastMints = [0, 1, 2].map((i) => readPubkey(data, off + i * 32));
  off += 96;
  const lastAmounts = [0, 1, 2].map((i) => readU64(data, off + i * 8));
  off += 24;
  const lastPrices = [0, 1, 2].map((i) => readU64(data, off + i * 8));
  off += 24;
  const lastPriceDecimals = [data[off], data[off + 1], data[off + 2]];
  off += 3;
  const lastPriceTs = [0, 1, 2].map((i) => readI64(data, off + i * 8));
  off += 24;
  const lastUsdcEach = readU64(data, off);
  off += 8;
  const lastFeeUsdc = readU64(data, off);
  off += 8;
  const lastSignatureHash = Uint8Array.from(data.subarray(off, off + 32));
  off += 32;
  const lastOrigin = data[off];
  return {
    ...base,
    card: {
      cardVersion,
      hasLastRun,
      lastRunIndex,
      lastBuyTs,
      lastSlot,
      lastMints,
      lastAmounts,
      lastPrices,
      lastPriceDecimals,
      lastPriceTs,
      lastUsdcEach,
      lastFeeUsdc,
      lastSignatureHash,
      lastOrigin,
    },
  };
}

/** Next manual/auto index. Shared counter. No last run → 0, else last + 1. */
export function nextCardRunIndex(card: Pick<UserCard, "hasLastRun" | "lastRunIndex">): number {
  if (!card.hasLastRun) return 0;
  const last = Number(card.lastRunIndex.toString());
  if (!Number.isSafeInteger(last) || last < 0) {
    throw new UserConfigDecodeError("UserConfig last_run_index");
  }
  return last + 1;
}

export type AccountMode = "onboarding" | "legacy" | "card";

export function accountMode(cfg: DecodedUserConfig | null | undefined): AccountMode {
  if (!cfg) return "onboarding";
  if (cfg.legacy || cfg.size === LEGACY_USER_CONFIG_LEN) return "legacy";
  if (cfg.size === CARD_USER_CONFIG_LEN && cfg.card?.cardVersion === CARD_VERSION) {
    return "card";
  }
  return "legacy";
}
