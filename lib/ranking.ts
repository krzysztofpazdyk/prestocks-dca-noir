/**
 * Weekly DCA ranking exists only from Jev:
 * 1. Grok analysis (if XAI_API_KEY) → Jev top-3 (client TYPESAFE BYOK, via /api/jev)
 * 2. Hosted API /rank or /run/dry — only when client TypeSafe BYOK is set
 * If none of those return a Jev ranking, ranking is unavailable.
 * Equal ⅓ buy of the 3 names is a separate Predca step.
 */

import { runByokAiRank } from "@/lib/ai-rank";
import { shown, translate } from "@/lib/i18n";
import { getLocaleSnapshot } from "@/lib/locale-store";
import {
  filterExpired,
  filterIpoCompleted,
  filterProducts,
  readRankPrefs,
  type RankPrefs,
} from "@/lib/rank-prefs";
import {
  postRank,
  rankResultFromProxy,
  triggerDryRun,
} from "@/lib/dca-api";
import {
  canUseSameOriginJevProxy,
  dcaApiBase,
  hasByokTypesafe,
  readTypesafeKey,
  readXaiKey,
  SS_RANK,
} from "@/lib/keys";
import {
  fetchPrestocksProducts,
  fillNoticeVars,
  type ProductsFetchResult,
} from "@/lib/prestocks";
import type { RankResult } from "@/lib/universe";

type RankStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

type RankSessionSnap = { raw: string | null };

const RANK_SERVER_SNAP: RankSessionSnap = { raw: null };
let rankRaw: string | null | undefined;
let rankSnap: RankSessionSnap = RANK_SERVER_SNAP;
const rankListeners = new Set<() => void>();

/** Stable fingerprint: sorted exclusions plus the four ranking flags. */
export function rankPrefsKey(prefs: RankPrefs = readRankPrefs()): string {
  const exclusions = [...prefs.exclusions].sort((a, b) => a.localeCompare(b, "en"));
  return JSON.stringify([
    exclusions,
    prefs.deadlinesUnimportant,
    prefs.premiumsMatter,
    prefs.premiumsEspeciallyNearIpo,
    prefs.buyDespiteIpo,
  ]);
}

/** A saved or live result counts only when Jev produced it. */
export function isJevRanking(rank: RankResult | null | undefined): boolean {
  if (!rank) return false;
  const pipeline = Array.isArray(rank.pipeline) ? rank.pipeline : [];
  if (!pipeline.includes("jev") || pipeline.includes("metrics_rank")) return false;
  return rank.mode === "hosted_jev" || rank.mode === "byok_ai";
}

export function parseRankSession(
  raw: string | null,
  prefsKeyNow: string,
): { rank: RankResult; savedAt: number } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      v?: unknown;
      rank?: RankResult;
      prefsKey?: unknown;
      savedAt?: unknown;
    };
    if (!parsed || parsed.v !== 2 || !parsed.rank || typeof parsed.rank !== "object") {
      return null;
    }
    if (!isJevRanking(parsed.rank)) return null;
    if (parsed.prefsKey !== prefsKeyNow) return null;
    if (typeof parsed.savedAt !== "number" || !Number.isFinite(parsed.savedAt)) return null;
    return { rank: parsed.rank, savedAt: parsed.savedAt };
  } catch {
    return null;
  }
}

export function saveRankSession(rank: RankResult, storage?: RankStore) {
  if (!isJevRanking(rank)) return;
  const envelope = {
    v: 2 as const,
    rank,
    prefsKey: rankPrefsKey(),
    savedAt: Date.now(),
  };
  const raw = JSON.stringify(envelope);
  try {
    (storage ?? sessionStorage).setItem(SS_RANK, raw);
    if (!storage) {
      rankRaw = raw;
      rankSnap = { raw };
      for (const listener of rankListeners) listener();
    }
  } catch {
    /* ignore */
  }
}

export function restoreRankSession(
  prefsKeyNow: string,
  storage?: RankStore,
): { rank: RankResult; savedAt: number } | null {
  try {
    const store = storage ?? (typeof sessionStorage === "undefined" ? null : sessionStorage);
    if (!store) return null;
    return parseRankSession(store.getItem(SS_RANK), prefsKeyNow);
  } catch {
    return null;
  }
}

function loadRankSession(): RankResult | null {
  return restoreRankSession(rankPrefsKey())?.rank ?? null;
}

export function rankSessionClientSnapshot(): RankSessionSnap {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(SS_RANK);
  } catch {
    raw = null;
  }
  if (rankRaw !== undefined && raw === rankRaw) return rankSnap;
  rankRaw = raw;
  rankSnap = { raw };
  return rankSnap;
}

export function rankSessionServerSnapshot(): RankSessionSnap {
  return RANK_SERVER_SNAP;
}

export function subscribeRankSession(onStoreChange: () => void): () => void {
  rankListeners.add(onStoreChange);
  if (typeof window === "undefined") {
    return () => {
      rankListeners.delete(onStoreChange);
    };
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key != null && event.key !== SS_RANK) return;
    rankRaw = undefined;
    onStoreChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    rankListeners.delete(onStoreChange);
    window.removeEventListener("storage", onStorage);
  };
}

function productsNotice(result: ProductsFetchResult): string | null {
  if (!result.errorKey) return result.errorPl;
  const locale = getLocaleSnapshot();
  return translate(
    locale,
    result.errorKey,
    fillNoticeVars(result.errorVars, (key, vars) => translate(locale, key, vars)),
  );
}

export async function loadInitialRanking(): Promise<{
  productsResult: ProductsFetchResult;
  rank: RankResult | null;
  error: string | null;
}> {
  const productsResult = await fetchPrestocksProducts();
  return {
    productsResult,
    rank: loadRankSession(),
    error: productsNotice(productsResult),
  };
}

function acceptJevRank(result: RankResult): RankResult | null {
  if (!isJevRanking(result) || result.top3.length < 3) return null;
  if (
    result.top3.some(
      (row) => typeof row.score !== "number" || !Number.isFinite(row.score),
    )
  ) {
    return null;
  }
  saveRankSession(result);
  return result;
}

/**
 * Run ranking now. Every path is Jev (BYOK /api/jev, then /rank, then /run/dry).
 * Without a TypeSafe key, or when every path fails, ranking is unavailable.
 */
export async function runRankingNow(
  productsResult: ProductsFetchResult,
): Promise<RankResult> {
  const prefs = readRankPrefs();
  const products = filterExpired(
    filterIpoCompleted(
      filterProducts(productsResult.products, prefs.exclusions),
      prefs.buyDespiteIpo,
    ),
    prefs.deadlinesUnimportant,
  );
  if (products.length < 3) {
    throw new Error(shown("msg.tooFewProducts"));
  }

  const byok = hasByokTypesafe();

  // GitHub Pages has no Route Handler — skip same-origin /api/jev (POST → 405).
  if (byok && canUseSameOriginJevProxy()) {
    try {
      const result = await runByokAiRank({
        products,
        premiumsSource: productsResult.premiumsSource,
        totals: productsResult.totals,
        typesafeKey: readTypesafeKey(),
        xaiKey: readXaiKey(),
        exclusions: prefs.exclusions,
        prefs,
      });
      const accepted = acceptJevRank(result);
      if (accepted) return accepted;
    } catch {
      /* try hosted Jev next */
    }
  }

  // Hosted /rank and /run/dry need client TypeSafe — never call without BYOK.
  if (byok && dcaApiBase()) {
    try {
      const proxy = await postRank(prefs);
      const pipeline = proxy.pipeline ?? ["prestocks", "jev"];
      if (
        proxy.ok !== false &&
        pipeline.includes("jev") &&
        !pipeline.includes("metrics_rank") &&
        proxy.top3.length >= 3
      ) {
        const accepted = acceptJevRank(rankResultFromProxy(proxy, products));
        if (accepted) return accepted;
      }
    } catch {
      /* try /run/dry next */
    }
    try {
      const accepted = acceptJevRank(
        await triggerDryRun(prefs.exclusions, prefs),
      );
      if (accepted) return accepted;
    } catch {
      /* no Jev ranking */
    }
  }

  throw new Error(shown("rank.err.jevUnavailable"));
}

export function activeModeLabel(
  rank: RankResult | null,
  hasByok: boolean,
): string {
  if (rank?.sourceLabel) return rank.sourceLabel;
  if (hasByok) return shown("rank.source.waiting");
  // Without client TypeSafe BYOK we never call hosted Jev — do not claim hosted.
  return shown("rank.source.noByok");
}
