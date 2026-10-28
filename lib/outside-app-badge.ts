import { translate, type Locale } from "@/lib/i18n";
import { formatGrouped } from "@/lib/number-format";
import { DUST } from "@/lib/position-value";

function asLocale(locale: string): Locale {
  return locale === "en" ? "en" : "pl";
}

/**
 * Visible badge for wallet tokens that were not bought in the app.
 * Null when there is nothing outside (including dust). Digits follow the
 * same browser number locale as the rest of the UI.
 */
export function outsideAppBadgeText(units: number, locale: string): string | null {
  if (!Number.isFinite(units) || units <= DUST) return null;
  const formatted = formatGrouped(units, { min: 1, max: 6 });
  if (!formatted) return null;
  return translate(asLocale(locale), "positions.outsideAppCount", { units: formatted });
}
