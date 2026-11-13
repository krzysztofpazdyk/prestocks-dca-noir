/**
 * close_user. Card mode only. Vault USDC is withdrawn in the same transaction
 * when the packet fits; otherwise the withdrawal goes out first.
 * Rent from UserConfig and the vault returns to the owner as one amount.
 */

import { BN, type Program } from "@coral-xyz/anchor";
import { PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { LEGACY_TX_PACKET_BYTES, legacyPacketBytes } from "@/lib/buy-ata";
import { ownerUsdcAta, userConfigPda, vaultPda, type UserConfigData } from "@/lib/predca";
import type { Predca } from "@/types/predca";
import {
  LS_AUTO_WEEKLY_BUY,
  LS_AUTO_WEEKLY_META,
  LS_WEEKLY_BUDGET,
  scopedLsKey,
} from "@/lib/auto-weekly-buy";
import { historyCacheKey, historyCacheLegacyKey } from "@/lib/history-events";
import { RUN_ORIGIN_LS_PREFIX } from "@/lib/run-origin";
import { accountMode, type AccountMode } from "@/lib/user-config";

export type CloseAccountUi = {
  /** The card is shown once an account exists. */
  visible: boolean;
  enabled: boolean;
  /** i18n key for the legacy hint. Null when the button can be used. */
  hintKey: "settings.closeAfterUpdate" | null;
};

export function closeAccountUi(input: {
  mode: AccountMode;
  accountUpdating: boolean;
  connected: boolean;
}): CloseAccountUi {
  if (!input.connected || input.mode === "onboarding") {
    return { visible: false, enabled: false, hintKey: null };
  }
  if (input.mode === "legacy" || input.accountUpdating) {
    return { visible: true, enabled: false, hintKey: "settings.closeAfterUpdate" };
  }
  if (input.mode !== "card") {
    return { visible: true, enabled: false, hintKey: "settings.closeAfterUpdate" };
  }
  return { visible: true, enabled: true, hintKey: null };
}

export function modeOfConfig(cfg: UserConfigData | null | undefined): AccountMode {
  if (!cfg) return "onboarding";
  if (cfg.legacy === true || cfg.size === 59) return "legacy";
  if (cfg.size === 305 && cfg.legacy === false && cfg.card?.cardVersion === 1) return "card";
  if (cfg.card?.cardVersion === 1 && cfg.legacy === false) return "card";
  return accountMode(
    cfg.size
      ? {
          size: cfg.size,
          legacy: false,
          owner: cfg.owner,
          weeklyBudgetUsdc: cfg.weeklyBudgetUsdc,
          excludeFlags: cfg.excludeFlags,
          lastRunTs: cfg.lastRunTs,
          bump: cfg.bump,
          vaultBump: cfg.vaultBump,
          card: cfg.card,
        }
      : null,
  );
}

/** Lamports on UserConfig plus the vault token account, as one SOL amount. */
export function accountFeeRefundSol(userConfigLamports: number, vaultLamports: number): number {
  const sum = (userConfigLamports || 0) + (vaultLamports || 0);
  if (!Number.isFinite(sum) || sum <= 0) return 0;
  return sum / 1_000_000_000;
}

export type CloseSubmitPlan = "close-only" | "single" | "two-step";

/**
 * Empty vault → close alone. A withdrawal that fits in front of close stays
 * in one transaction. A packet over the legacy limit is two signatures.
 */
export function closeSubmitPlan(vaultRaw: bigint, serializedBytes: number): CloseSubmitPlan {
  if (vaultRaw <= BigInt(0)) return "close-only";
  if (
    Number.isFinite(serializedBytes) &&
    serializedBytes > 0 &&
    serializedBytes <= LEGACY_TX_PACKET_BYTES
  ) {
    return "single";
  }
  return "two-step";
}

export async function buildCloseInstructions(
  program: Program<Predca>,
  owner: PublicKey,
  usdcMint: PublicKey,
  vaultRaw: bigint,
): Promise<TransactionInstruction[]> {
  const instructions: TransactionInstruction[] = [];
  if (vaultRaw > BigInt(0)) {
    instructions.push(
      await program.methods
        .withdrawUsdc(new BN(vaultRaw.toString()))
        .accounts({
          usdcMint,
          ownerUsdc: ownerUsdcAta(owner, usdcMint),
        })
        .instruction(),
    );
  }
  instructions.push(await program.methods.closeUser().instruction());
  return instructions;
}

export function closeTransaction(
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

export function planCloseTransaction(
  instructions: readonly TransactionInstruction[],
  feePayer: PublicKey,
  recentBlockhash: string,
  vaultRaw: bigint,
): { plan: CloseSubmitPlan; tx: Transaction } {
  const tx = closeTransaction(instructions, feePayer, recentBlockhash);
  return { plan: closeSubmitPlan(vaultRaw, legacyPacketBytes(tx)), tx };
}

/** Drop this owner's history cache, purchase origins, budget, and auto-buy bits. */
export function clearClosedOwnerState(storage: Storage, owner: string): void {
  const exact = [
    historyCacheKey(owner),
    historyCacheLegacyKey(owner),
    scopedLsKey(LS_AUTO_WEEKLY_BUY, owner),
    scopedLsKey(LS_AUTO_WEEKLY_META, owner),
    scopedLsKey(LS_WEEKLY_BUDGET, owner),
  ];
  for (const key of exact) storage.removeItem(key);
  const prefix = `${RUN_ORIGIN_LS_PREFIX}.${owner}.`;
  const matched: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key && key.startsWith(prefix)) matched.push(key);
  }
  for (const key of matched) storage.removeItem(key);
}

export function closeAccounts(owner: PublicKey): { userConfig: PublicKey; vault: PublicKey } {
  return {
    userConfig: userConfigPda(owner)[0],
    vault: vaultPda(owner)[0],
  };
}
