export type HistoryMode =
  | "disconnected"
  | "loading"
  | "list"
  | "list_stale"
  | "empty"
  | "error"
  | "not_ready";

/** Which History block to show. An RPC error keeps the last runs. */
export function historyView(
  status: string,
  runsLength: number,
  connected: boolean,
): HistoryMode {
  if (!connected) return "disconnected";
  if (status === "loading") return "loading";
  if (runsLength > 0 && (status === "ready" || status === "error")) {
    return status === "error" ? "list_stale" : "list";
  }
  if (status === "ready") return "empty";
  if (status === "error") return "error";
  if (status === "no_config" || status === "no_mint") return "not_ready";
  return "not_ready";
}

export type HistoryPriceState = "priced" | "legacy" | "unknown";

/** USD for one history leg. Unknown RunPrice must not treat token units as dollars. */
export function historyLegUsd(
  priceState: HistoryPriceState,
  slotUsdc: number | null | undefined,
  recordAmountUsd: number,
): number | null {
  if (priceState === "unknown") return null;
  if (slotUsdc != null && Number.isFinite(slotUsdc)) return slotUsdc;
  return Number.isFinite(recordAmountUsd) ? recordAmountUsd : null;
}

/** Sum of leg USD. Null when the run price is unknown or any leg is. */
export function historyBudgetUsd(
  priceState: HistoryPriceState,
  legs: Array<number | null>,
): number | null {
  if (priceState === "unknown") return null;
  if (legs.some((n) => n == null || !Number.isFinite(n))) return null;
  return legs.reduce<number>((sum, n) => sum + (n ?? 0), 0);
}
