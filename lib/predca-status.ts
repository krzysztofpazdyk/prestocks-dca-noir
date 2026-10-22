import { shown } from "@/lib/i18n";
import type { MockTokenBalance, RunRecordData, UserConfigData } from "@/lib/predca";

export type PredcaStatus =
  | "disconnected"
  | "loading"
  | "no_config"
  | "ready"
  | "no_mint"
  | "error";

export type ConfigState = "unknown" | "missing" | "present";

export type PredcaSnapshot = {
  config: UserConfigData | null;
  configState: ConfigState;
  vaultUsdc: number | null;
  ownerUsdc: number | null;
  solBalance: number | null;
  tokenBalances: MockTokenBalance[];
  runs: RunRecordData[];
  rpcError: string | null;
  /** i18n key. Token ATA read failed softly; previous balances stay. */
  balanceWarning?: string | null;
  /** i18n key. At least one run has no confirmed RunPrice yet. */
  priceWarning?: string | null;
  /**
   * i18n key. A refresh read timed out. Previous snapshot stays.
   * Not `rpcError`: a slow Devnet read must not block a manual buy.
   */
  rpcWarning?: string | null;
};

export const EMPTY_SNAPSHOT: PredcaSnapshot = {
  config: null,
  configState: "unknown",
  vaultUsdc: null,
  ownerUsdc: null,
  solBalance: null,
  tokenBalances: [],
  runs: [],
  rpcError: null,
};

/** i18n key for a timed-out refresh that kept the previous snapshot. */
export const RPC_TIMEOUT_WARNING_KEY = "rpc.timeoutWarning";

export type RefreshOutcome =
  | {
      ok: true;
      config: UserConfigData | null;
      vaultUsdc: number | null;
      ownerUsdc: number | null;
      solBalance: number | null;
      tokenBalances: MockTokenBalance[];
      /** Keep `prev.tokenBalances` and set a non-blocking warning. */
      tokenBalancesStale?: boolean;
      runs: RunRecordData[];
    }
  | { ok: false; error: string; soft?: false }
  | { ok: false; soft: true; warning?: string };

/**
 * Success replaces the snapshot and clears warnings.
 * A hard failure keeps the last-known fields and sets rpcError.
 * A soft timeout keeps the last-known fields, does not set rpcError, and
 * sets `rpcWarning`. A previous `balanceWarning` stays until a successful read.
 */
export function nextSnapshotAfterRefresh(
  prev: PredcaSnapshot,
  outcome: RefreshOutcome,
): PredcaSnapshot {
  if (!outcome.ok && outcome.soft === true) {
    return {
      ...prev,
      rpcWarning: outcome.warning ?? RPC_TIMEOUT_WARNING_KEY,
    };
  }
  if (!outcome.ok) {
    return { ...prev, rpcError: outcome.error, rpcWarning: null };
  }
  return {
    config: outcome.config,
    configState: outcome.config ? "present" : "missing",
    vaultUsdc: outcome.vaultUsdc,
    ownerUsdc: outcome.ownerUsdc,
    solBalance: outcome.solBalance,
    tokenBalances: outcome.tokenBalancesStale ? prev.tokenBalances : outcome.tokenBalances,
    runs: outcome.runs,
    rpcError: null,
    balanceWarning: outcome.tokenBalancesStale ? "balances.warning" : null,
    priceWarning: null,
    rpcWarning: null,
  };
}

export function derivePredcaStatus(i: {
  hasOwner: boolean;
  hasMint: boolean;
  loading: boolean;
  configState: ConfigState;
  rpcError: string | null;
}): PredcaStatus {
  if (!i.hasOwner) return "disconnected";
  if (!i.hasMint) return "no_mint";
  if (i.rpcError) return "error";
  if (i.configState === "present") return "ready";
  if (i.configState === "missing") return i.loading ? "loading" : "no_config";
  return "loading";
}

export type DepositPlan = "init_deposit" | "deposit" | "blocked";

export function depositPlan(
  configState: ConfigState,
  rpcError: string | null,
): DepositPlan {
  if (rpcError) return "blocked";
  if (configState === "present") return "deposit";
  if (configState === "missing") return "init_deposit";
  return "blocked";
}

export type DepositUi = "enabled" | "disabled" | "hidden";

/** Deposit tile. An RPC error stays visible and disabled, including an unknown account. */
export function depositUi(
  status: PredcaStatus,
  connected: boolean,
  hasMint: boolean,
): DepositUi {
  if (!connected || !hasMint) return "hidden";
  if (status === "ready" || status === "no_config") return "enabled";
  if (status === "error") return "disabled";
  return "hidden";
}

export type WithdrawUi = "enabled" | "disabled" | "hidden";

export function withdrawUi(
  status: PredcaStatus,
  hasLastKnownConfig: boolean,
): WithdrawUi {
  if (status === "ready") return "enabled";
  if (status === "error" && hasLastKnownConfig) return "disabled";
  return "hidden";
}

export function rpcReadErrorMessage(): string {
  return shown("predca.rpcReadError");
}
