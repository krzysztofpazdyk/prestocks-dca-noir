/**
 * One number format for the whole app, like Jupiter: the browser language,
 * not the PL/EN copy switch. The dollar sign stays in front of the digits.
 *
 * Static export: the first render (and hydration) uses en-US. After hydration
 * the provider publishes navigator.languages[0] || navigator.language.
 * Formatters read that published tag, so server HTML and the hydration
 * render agree.
 */

export const NUMBER_LOCALE_FALLBACK = "en-US";

type Listener = () => void;
const listeners = new Set<Listener>();

/** null until the provider publishes a tag. Formatters then use en-US. */
let adopted: string | null = null;

export function readBrowserNumberLocale(): string {
  if (typeof navigator === "undefined") return NUMBER_LOCALE_FALLBACK;
  const list = navigator.languages;
  const first = list && list.length > 0 ? list[0] : "";
  return first || navigator.language || NUMBER_LOCALE_FALLBACK;
}

/** Tag used by every formatter. en-US until the browser locale is published. */
export function numberLocale(): string {
  return adopted ?? NUMBER_LOCALE_FALLBACK;
}

export function subscribeNumberLocale(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Publish the tag for this render. The provider calls this with the
 * useSyncExternalStore snapshot (en-US during hydration, browser after).
 * Does not notify: the provider's own re-render already updates children.
 */
export function syncNumberLocale(locale: string): void {
  adopted = locale || NUMBER_LOCALE_FALLBACK;
}

/** Tests pin the tag. Pass null to return to the pre-hydration fallback. */
export function setNumberLocaleForTests(locale: string | null): void {
  adopted = locale;
  for (const listener of listeners) listener();
}

export type GroupedOptions = {
  min?: number;
  max?: number;
  signDisplay?: Intl.NumberFormatOptions["signDisplay"];
};

/** Digits only. Grouping follows the browser locale (no K/M abbreviations). */
export function formatGrouped(value: number, opts?: GroupedOptions): string {
  if (!Number.isFinite(value)) return "";
  const options: Intl.NumberFormatOptions = {
    maximumFractionDigits: opts?.max ?? 6,
    useGrouping: "auto",
  };
  if (opts?.min != null) options.minimumFractionDigits = opts.min;
  if (opts?.signDisplay) options.signDisplay = opts.signDisplay;
  return new Intl.NumberFormat(numberLocale(), options).format(value);
}

/**
 * USD/USDC amount. "$" is always immediately before the digits.
 * A minus or plus sits in front of the dollar sign: "-$4.10", "+$12.30".
 */
export function formatDollars(
  value: number,
  digits = 2,
  signed = false,
): string {
  if (!Number.isFinite(value)) return "";
  const body = formatGrouped(Math.abs(value), { min: digits, max: digits });
  if (value < 0) return `-$${body}`;
  if (signed && value > 0) return `+$${body}`;
  return `$${body}`;
}

/** One decimal percent. Minus is U+2212, matching the premium column. */
export function formatPercent(value: number, digits = 1): string {
  const body = formatGrouped(value, {
    min: digits,
    max: digits,
    signDisplay: "exceptZero",
  });
  return `${body.replace(/-/g, "\u2212")}%`;
}
