import { formatGrouped } from "@/lib/number-format";

export type PurchaseFeeRow = {
  runIndex: number;
  feeUsd: number;
  /**
   * Account sequence. Omitted means the open account, never an older
   * account that reused the same runIndex.
   */
  generation?: number;
};

type FeeCopy = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

/**
 * Settings and the deposit hint use this. Unknown or off stays hidden.
 * A past feeUsd does not turn the hint on by itself.
 */
export function purchaseFeeEnabled(
  status: { feeEnabled?: boolean } | null | undefined,
): boolean {
  return status?.feeEnabled === true;
}

/** Ceil to 4 decimal USD places. An exact 4-decimal value is unchanged. */
export function ceilFeeUsd(amount: number): number | null {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const scaled = Math.ceil(amount * 10000 - 1e-9);
  if (!Number.isFinite(scaled) || scaled <= 0) return null;
  return scaled / 10000;
}

export function formatFeeAmount(amount: number): string | null {
  const ceiled = ceilFeeUsd(amount);
  if (ceiled == null) return null;
  const text = formatGrouped(ceiled, { max: 4 });
  return text.length > 0 ? text : null;
}

/** Per-run note. Zero, missing, and non-finite amounts produce no line. */
export function historyFeeLabel(
  feeUsd: number | null | undefined,
  t: FeeCopy,
): string | null {
  if (typeof feeUsd !== "number") return null;
  const fee = formatFeeAmount(feeUsd);
  if (!fee) return null;
  return t("history.fee", { fee });
}

function accountSequence(value: number | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  return fallback;
}

/**
 * Fee for one history row, matched on generation and runIndex.
 * `generation` defaults to the open account (`currentGeneration`, else 0),
 * so feeUsdForRun(fees, "1") still hits rows that omit generation or use 0.
 * A row that omits generation belongs to the open account and is not applied
 * to an older account with the same runIndex.
 */
export function feeUsdForRun(
  fees: PurchaseFeeRow[] | null | undefined,
  runIndex: number | string,
  generation?: number,
  currentGeneration?: number,
): number | undefined {
  if (!fees || fees.length === 0) return undefined;
  const index = typeof runIndex === "number" ? runIndex : Number(runIndex);
  if (!Number.isFinite(index)) return undefined;
  const current = accountSequence(currentGeneration, 0);
  const want = accountSequence(generation, current);
  for (let i = fees.length - 1; i >= 0; i--) {
    const row = fees[i];
    if (!row || row.runIndex !== index || typeof row.feeUsd !== "number") continue;
    const rowGeneration = accountSequence(row.generation, current);
    if (rowGeneration !== want) continue;
    return row.feeUsd;
  }
  return undefined;
}

function needLabel(
  status: { need?: number } | null | undefined,
  budgetUsd: number,
): string {
  const fromStatus = status?.need;
  const amount =
    typeof fromStatus === "number" && Number.isFinite(fromStatus)
      ? fromStatus
      : Number.isFinite(budgetUsd)
        ? budgetUsd
        : 0;
  return formatGrouped(amount, { min: 2, max: 2 });
}

/**
 * vault_low copy. `{need}` is the status field when the server sent one,
 * otherwise the weekly budget. `{fee}` is that purchase's feeUsd.
 */
export function vaultLowCopy(
  status: { need?: number; feeUsd?: number } | null | undefined,
  budgetUsd: number,
  t: FeeCopy,
): string {
  const need = needLabel(status, budgetUsd);
  const fee =
    status != null && typeof status.feeUsd === "number"
      ? formatFeeAmount(status.feeUsd)
      : null;
  if (fee) return t("auto.status.vaultLowFee", { need, fee });
  return t("auto.status.vaultLow", { need });
}
