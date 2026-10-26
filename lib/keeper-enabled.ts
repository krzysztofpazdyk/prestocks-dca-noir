/**
 * Whether keeper status authoritatively says this owner has auto-buy on.
 * `null` means the payload is not a status for this wallet (missing sign,
 * unreachable keeper, rejected signature, or no `enabled` field). Callers
 * must not turn the toggle Off on `null`.
 */
export function keeperEnabledForConnectedOwner(
  st: { ok?: boolean; enabled?: boolean; owner?: string; error?: string },
  wallet: string | null,
): boolean | null {
  if (!wallet) return null;
  const error = typeof st.error === "string" ? st.error : "";
  // No keeper session yet: unknown, never Off. A signed read fills this in.
  if (
    error === "wallet_required" ||
    error === "signature_rejected" ||
    error === "session_required" ||
    error.startsWith("sign_rejected")
  ) {
    return null;
  }
  // keeper_unreachable with no enabled field is unknown. A payload that still
  // carries enabled + this owner is authoritative; the banner handles the blip.
  if (error === "keeper_unreachable" && typeof st.enabled !== "boolean") {
    return null;
  }
  if (typeof st.enabled !== "boolean") return null;
  const configured =
    typeof st.owner === "string" && st.owner.trim() ? st.owner.trim() : null;
  if (!configured) return null;
  if (configured !== wallet) return false;
  return st.enabled;
}

/**
 * The status toggle must ask for a signature instead of looking Off.
 * Silent reads use `session_required`. An interactive read that the wallet
 * rejects stays in the same unknown state.
 */
export function keeperStatusNeedsSignature(st: { error?: string }): boolean {
  const error = typeof st.error === "string" ? st.error : "";
  return (
    error === "session_required" ||
    error === "signature_rejected" ||
    error.startsWith("sign_rejected")
  );
}

/**
 * Phases where /enable has not settled the on/off bit. The daemon writes
 * `enabled: false` for the whole purchase (`enabling`, then `buying`).
 */
const TRANSITIONAL_AUTO_BUY_PHASES = new Set([
  "enabling",
  "buying",
  "checking",
  "ranking",
  "confirming",
  "pending",
]);

export type AutoBuyStatusSnapshot = {
  ok?: boolean;
  enabled?: boolean;
  owner?: string;
  error?: string;
  phase?: string | null;
};

/**
 * A silent read that must not replace the enable/disable bit.
 * No `enabled` field is unknown. `enabled: false` with no phase, or with a
 * phase still inside enable, is the temporary off written while the purchase
 * runs. A settled phase (`off`, `error`, …) with `enabled: false` is real.
 */
export function autoBuyStatusIsTransitional(st: {
  enabled?: boolean;
  phase?: string | null;
}): boolean {
  if (typeof st.enabled !== "boolean") return true;
  if (st.enabled === true) return false;
  const phase = typeof st.phase === "string" ? st.phase.trim() : "";
  if (!phase) return true;
  return TRANSITIONAL_AUTO_BUY_PHASES.has(phase);
}

/**
 * Next toggle value. `actionEnabled` is the enable/disable response
 * (`null` before this wallet has acted). A later silent status replaces it
 * only when that payload authoritatively names this wallet and is not
 * transitional. `null` means "do not touch the toggle".
 */
export function nextAutoBuyEnabled(
  actionEnabled: boolean | null,
  st: AutoBuyStatusSnapshot,
  wallet: string | null,
): boolean | null {
  if (actionEnabled !== null && autoBuyStatusIsTransitional(st)) {
    return actionEnabled;
  }
  const verdict = keeperEnabledForConnectedOwner(st, wallet);
  if (verdict === null) return actionEnabled;
  return verdict;
}

export type AutoBuyActionStatusPatch = {
  /** On/off from the enable or disable response. A silent read must not replace it. */
  enabled: boolean;
  needsSignature: boolean;
  /**
   * False on `session_required`: the caller sets `needsSignature` only and
   * leaves `statusResolved` (and the action bit) as the action left them.
   */
  touchStatusResolved: boolean;
  statusResolved: boolean;
};

/**
 * After a successful enable or disable. The action response owns on/off.
 * A following silent status read never opens a wallet prompt. `session_required`
 * only raises `needsSignature`.
 */
export function applyAutoBuyActionStatus(
  actionEnabled: boolean,
  st: { error?: string },
): AutoBuyActionStatusPatch {
  if (keeperStatusNeedsSignature(st)) {
    return {
      enabled: actionEnabled,
      needsSignature: true,
      touchStatusResolved: false,
      statusResolved: true,
    };
  }
  return {
    enabled: actionEnabled,
    needsSignature: false,
    touchStatusResolved: true,
    statusResolved: true,
  };
}
