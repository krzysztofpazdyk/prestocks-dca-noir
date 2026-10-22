/**
 * The premium the Overview shows. Same number as the "Ceny tokenów vs wycena spółek" panel.
 */

import { canonicalName, ipoPremiumPct, quoteByName, type JupPrices } from "@/lib/jup-prices";
import { formatPercent } from "@/lib/number-format";
import { REFERENCE_MINTS, type RankResult } from "@/lib/universe";

export function livePremiumPct(name: string, prices: JupPrices): number | null {
  const quote = quoteByName(prices.quotes, name);
  if (!quote) return null;
  return ipoPremiumPct(quote, prices.fetchedAt);
}

export type PremiumTone = "discount" | "premium" | "neutral";

/**
 * 1 decimal, sign always: „+24.2%”, „−24.2%” (U+2212), „0.0%”.
 * Digits follow the browser, not the PL/EN switch. `locale` stays so callers
 * do not change; both languages share one number format.
 */
export function formatPremiumPct(pct: number, locale: string): string {
  void locale;
  return formatPercent(pct, 1);
}

/** |pct| < 0.05 (rounds to 0.0) → "at"; null/NaN → "none". */
export function premiumKind(pct: number | null): "above" | "below" | "at" | "none" {
  if (pct == null || !Number.isFinite(pct)) return "none";
  if (Math.abs(pct) < 0.05) return "at";
  return pct > 0 ? "above" : "below";
}

export function showsSpacexDiscount(name: string): boolean {
  const want = canonicalName(name);
  return Object.keys(REFERENCE_MINTS).some((key) => canonicalName(key) === want);
}

export type PremiumCopy = {
  textKey: string;
  tooltipKey: string;
  labelKey: string;
  tone: PremiumTone;
  withPct: boolean;
};

/**
 * SpaceX is a discount versus SPCXx, not a valuation premium.
 * `cell` empty state is the short „brak danych”; `inline` keeps the longer sentence.
 */
export function premiumCopy(
  name: string,
  pct: number | null,
  stale: boolean,
  surface: "inline" | "cell",
): PremiumCopy {
  const tone = premiumTone(pct, stale);
  const kind = premiumKind(pct);
  const spacex = showsSpacexDiscount(name);
  const tooltipKey = spacex ? "premium.spacex.tooltip" : "premium.tooltip";
  const labelKey = spacex ? "premium.spacex.label" : "premium.label";
  if (kind === "none" || pct == null) {
    return {
      textKey: spacex
        ? "premium.spacex.noData"
        : surface === "cell"
          ? "positions.noData"
          : "premium.noData",
      tooltipKey,
      labelKey,
      tone,
      withPct: false,
    };
  }
  if (spacex && kind === "above") {
    return {
      textKey: "premium.spacex.premium",
      tooltipKey,
      labelKey: "premium.spacex.premiumLabel",
      tone,
      withPct: true,
    };
  }
  const textKey = spacex
    ? "premium.spacex.value"
    : kind === "above"
      ? "premium.above"
      : kind === "below"
        ? "premium.below"
        : "premium.atValuation";
  return { textKey, tooltipKey, labelKey, tone, withPct: true };
}

/** Buyer color. stale (cache/carried) → always neutral. */
export function premiumTone(pct: number | null, stale: boolean): PremiumTone {
  if (stale || pct == null || !Number.isFinite(pct)) return "neutral";
  if (pct < 0) return Math.abs(pct) < 0.05 ? "neutral" : "discount";
  if (pct > 0) return Math.abs(pct) < 0.05 ? "neutral" : "premium";
  return "neutral";
}

/** Same classes as PnL (positive green, negative red, flat muted). */
export const PREMIUM_TONE_CLASS: Record<PremiumTone, string> = {
  discount: "text-[#34d399]",
  premium: "text-[#f87171]",
  neutral: "text-[#8b95a8]",
};

export function premiumBasisFor(
  where: "server" | "client",
  premiumsMatter: boolean,
): RankResult["premiumBasis"] {
  if (!premiumsMatter) return "none";
  return where === "server" ? "server_estimate" : "live";
}
