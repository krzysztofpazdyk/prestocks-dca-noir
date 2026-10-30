/**
 * Ranking USER_PREFS from Settings — exclusions + deadline/IPO toggles.
 * Persisted in localStorage; read by Overview / ranking / postRank.
 */

import {
  LS_EXCLUSIONS,
  filterProducts,
  filterTop3,
  isProductExcluded,
  mintsForExclusionName,
  parseExclusions,
  readExclusions,
  readExclusionsRaw,
  writeExclusionsRaw,
} from "@/lib/exclusions";
import { DEFAULT_SETTINGS } from "@/lib/mock-data";

export const LS_DEADLINE_INVALID = "noir3.prestocks.deadlineInvalid";
export const LS_IPO_PREMIUM = "noir3.prestocks.ipoPremiumMatters";
export const LS_BUY_DESPITE_IPO = "noir3.prestocks.buyDespiteIpo";

export {
  LS_EXCLUSIONS,
  filterProducts,
  filterTop3,
  isProductExcluded,
  mintsForExclusionName,
  parseExclusions,
  readExclusions,
  readExclusionsRaw,
  writeExclusionsRaw,
};

function readBool(key: string, fallback: boolean): boolean {
  try {
    if (typeof localStorage === "undefined") return fallback;
    const v = localStorage.getItem(key);
    if (v == null) return fallback;
    if (v === "true" || v === "1") return true;
    if (v === "false" || v === "0") return false;
    return fallback;
  } catch {
    return fallback;
  }
}

function writeBool(key: string, value: boolean): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(key, value ? "true" : "false");
    }
  } catch {
    /* ignore */
  }
}

/** Toggle ON = deadlines unimportant for ranking. */
export function readDeadlineInvalid(): boolean {
  return readBool(LS_DEADLINE_INVALID, DEFAULT_SETTINGS.deadlineInvalid);
}

export function writeDeadlineInvalid(value: boolean): void {
  writeBool(LS_DEADLINE_INVALID, value);
}

/** Toggle ON = weight premium/discount vs mark when ranking. */
export function readIpoPremiumMatters(): boolean {
  return readBool(LS_IPO_PREMIUM, DEFAULT_SETTINGS.ipoPremiumMatters);
}

export function writeIpoPremiumMatters(value: boolean): void {
  writeBool(LS_IPO_PREMIUM, value);
}

/** Toggle ON = allow PreStocks that have already IPO'd. */
export function readBuyDespiteIpo(): boolean {
  return readBool(LS_BUY_DESPITE_IPO, DEFAULT_SETTINGS.buyDespiteIpo);
}

export function writeBuyDespiteIpo(value: boolean): void {
  writeBool(LS_BUY_DESPITE_IPO, value);
}

export function filterIpoCompleted<T extends { ipo_completed?: boolean }>(
  rows: T[],
  buyDespiteIpo: boolean,
): T[] {
  if (buyDespiteIpo) return rows;
  return rows.filter((r) => !r.ipo_completed);
}

export type DeadlineRow = {
  deadline_invalid?: boolean;
  deadline_at?: number | null;
};

/** True when we know a date or a past-expiry flag. Do not invent a date. */
export function hasKnownDeadline(row: DeadlineRow): boolean {
  return (
    (row.deadline_at != null && Number.isFinite(row.deadline_at)) ||
    !!row.deadline_invalid
  );
}

/**
 * Past expiry vs `now`. A known date is the source of truth; a boolean flag
 * is used only when there is no date.
 */
export function isDeadlinePast(row: DeadlineRow, now: number): boolean {
  if (row.deadline_at != null && Number.isFinite(row.deadline_at)) {
    return row.deadline_at < now;
  }
  return !!row.deadline_invalid;
}

/** Always drop names whose deadline has already passed. */
export function filterPastDeadline<T extends DeadlineRow>(
  rows: T[],
  now: number = Date.now(),
): T[] {
  return rows.filter((r) => !isDeadlinePast(r, now));
}

/**
 * Always drop names past expiry. Toggle OFF (`allowWithDeadline=false`) also
 * drops names that have any known deadline (still in the future). Toggle ON
 * keeps those until the date passes. `deadlinesUnimportant=true` is ON.
 */
export function filterExpired<T extends DeadlineRow>(
  rows: T[],
  allowWithDeadline: boolean,
  now: number = Date.now(),
): T[] {
  return rows.filter((r) => {
    if (isDeadlinePast(r, now)) return false;
    if (!allowWithDeadline && hasKnownDeadline(r)) return false;
    return true;
  });
}

/** Alias matching Settings copy / filterIpoCompleted naming. */
export const filterDeadlines = filterExpired;

export type RankPrefs = {
  exclusions: string[];
  /** Raw typed exclusions string (for API body echo if needed). */
  exclusionsRaw: string;
  /** Mapped from deadlineInvalid toggle. */
  deadlinesUnimportant: boolean;
  /** Weight premium/discount vs mark valuation. */
  premiumsMatter: boolean;
  /** Kept for API compatibility; same as premiumsMatter. */
  premiumsEspeciallyNearIpo: boolean;
  deadlineInvalid: boolean;
  ipoPremiumMatters: boolean;
  /** Allow names that have already completed an IPO. */
  buyDespiteIpo: boolean;
};

export function readRankPrefs(): RankPrefs {
  const deadlineInvalid = readDeadlineInvalid();
  const ipoPremiumMatters = readIpoPremiumMatters();
  const buyDespiteIpo = readBuyDespiteIpo();
  return {
    exclusions: readExclusions(),
    exclusionsRaw: readExclusionsRaw(),
    deadlinesUnimportant: deadlineInvalid,
    premiumsMatter: ipoPremiumMatters,
    premiumsEspeciallyNearIpo: ipoPremiumMatters,
    deadlineInvalid,
    ipoPremiumMatters,
    buyDespiteIpo,
  };
}

/** JSON-serializable body fields for POST /rank and env-mappable prefs. */
export function rankPrefsForApi(prefs?: RankPrefs): {
  exclusions: string[];
  deadlines_unimportant: boolean;
  premiums_matter: boolean;
  premiums_especially_near_ipo: boolean;
  buy_despite_ipo: boolean;
} {
  const p = prefs ?? readRankPrefs();
  return {
    exclusions: p.exclusions,
    deadlines_unimportant: p.deadlinesUnimportant,
    premiums_matter: p.premiumsMatter,
    premiums_especially_near_ipo: p.premiumsEspeciallyNearIpo,
    buy_despite_ipo: p.buyDespiteIpo,
  };
}

/** Snake_case prefs as returned by keeper GET /prefs (inverse of rankPrefsForApi). */
export type ApiRankPrefs = {
  exclusions: string[];
  deadlines_unimportant: boolean;
  premiums_matter: boolean;
  premiums_especially_near_ipo: boolean;
  buy_despite_ipo: boolean;
};

/**
 * Map keeper/API prefs into localStorage via existing writers.
 * Partial payloads apply only defined fields. Returns refreshed RankPrefs.
 */
export function applyApiPrefsToLocal(
  api: Partial<ApiRankPrefs> | null | undefined,
): RankPrefs {
  if (!api) return readRankPrefs();
  if (Array.isArray(api.exclusions)) {
    writeExclusionsRaw(api.exclusions.join(", "));
  }
  if (typeof api.deadlines_unimportant === "boolean") {
    writeDeadlineInvalid(api.deadlines_unimportant);
  }
  const premiums =
    typeof api.premiums_matter === "boolean"
      ? api.premiums_matter
      : typeof api.premiums_especially_near_ipo === "boolean"
        ? api.premiums_especially_near_ipo
        : undefined;
  if (typeof premiums === "boolean") {
    writeIpoPremiumMatters(premiums);
  }
  if (typeof api.buy_despite_ipo === "boolean") {
    writeBuyDespiteIpo(api.buy_despite_ipo);
  }
  return readRankPrefs();
}
