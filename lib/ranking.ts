/**
 * Weekly DCA ranking:
 * 1. Grok analysis (if XAI_API_KEY) → Jev top-3 (TYPESAFE_API_KEY, via /api/jev)
 * 2. Else hosted API /rank or /run/dry
 * 3. metrics_rank ONLY if Jev is down — clearly labeled
 * Equal ⅓ buy of the 3 names is a separate Predca step.
 */

import { runByokAiRank } from "@/lib/ai-rank";
import {
  filterExpired,
  filterIpoCompleted,
  filterProducts,
  readRankPrefs,
} from "@/lib/rank-prefs";
import {
  emergencyFromProducts,
  fetchLatestRun,
  fetchSampleRun,
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
  type ProductsFetchResult,
} from "@/lib/prestocks";
import type { RankResult } from "@/lib/universe";

function saveRankSession(rank: RankResult) {
  try {
    sessionStorage.setItem(SS_RANK, JSON.stringify(rank));
  } catch {
    /* ignore */
  }
}

function loadRankSession(): RankResult | null {
  try {
    const raw = sessionStorage.getItem(SS_RANK);
    if (!raw) return null;
    return JSON.parse(raw) as RankResult;
  } catch {
    return null;
  }
}

export async function loadInitialRanking(): Promise<{
  productsResult: ProductsFetchResult;
  rank: RankResult | null;
  error: string | null;
}> {
  const productsResult = await fetchPrestocksProducts();
  let rank: RankResult | null = null;
  let error: string | null = productsResult.errorPl;

  if (dcaApiBase()) {
    try {
      rank = await fetchLatestRun();
    } catch (e) {
      error = `API /run/latest: ${e instanceof Error ? e.message : e}`;
    }
  }

  if (!rank) rank = loadRankSession();
  if (!rank) rank = await fetchSampleRun();

  // Do NOT metrics-rank as default — only surface products / last Jev result.
  if (rank) saveRankSession(rank);

  return { productsResult, rank, error };
}

/**
 * Run ranking now: Grok→Jev when TYPESAFE_API_KEY is set, else hosted
 * /rank or /run/dry, else emergency metrics.
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
    throw new Error("Za mało produktów PreStocks do rankingu (<3).");
  }

  let byokFallback: RankResult | null = null;
  // GitHub Pages has no Route Handler — skip same-origin /api/jev (POST → 405).
  if (hasByokTypesafe() && canUseSameOriginJevProxy()) {
    const result = await runByokAiRank({
      products,
      premiumsSource: productsResult.premiumsSource,
      totals: productsResult.totals,
      typesafeKey: readTypesafeKey(),
      xaiKey: readXaiKey(),
      exclusions: prefs.exclusions,
      prefs,
    });
    if (result.mode !== "metrics_fallback") {
      saveRankSession(result);
      return result;
    }
    byokFallback = result;
    if (!dcaApiBase()) {
      saveRankSession(result);
      return result;
    }
  }

  if (dcaApiBase()) {
    try {
      const proxy = await postRank(prefs);
      if (proxy.top3.length >= 3) {
        const result = rankResultFromProxy(proxy, products);
        saveRankSession(result);
        return result;
      }
    } catch {
      /* try /run/dry next */
    }
    try {
      const result = await triggerDryRun(prefs.exclusions, prefs);
      saveRankSession(result);
      return result;
    } catch (e) {
      if (byokFallback) {
        saveRankSession(byokFallback);
        return byokFallback;
      }
      const reason = `Hosted Jev niedostępny (${e instanceof Error ? e.message : e}). Awaryjny ranking metryczny.`;
      const fallback = emergencyFromProducts(
        products,
        reason,
        prefs.exclusions,
        prefs,
      );
      saveRankSession(fallback);
      return fallback;
    }
  }

  if (byokFallback) {
    saveRankSession(byokFallback);
    return byokFallback;
  }

  const fallback = emergencyFromProducts(
    products,
    "Brak TYPESAFE (BYOK) i brak NEXT_PUBLIC_DCA_API_URL — Jev nie może wystartować. Awaryjny ranking metryczny.",
    prefs.exclusions,
    prefs,
  );
  saveRankSession(fallback);
  return fallback;
}

export function activeModeLabel(
  rank: RankResult | null,
  hasByok: boolean,
): string {
  if (rank?.sourceLabel) return rank.sourceLabel;
  if (hasByok) return "Źródło: PreStocks + AI (BYOK) — czekam na ranking";
  if (dcaApiBase())
    return "Źródło: PreStocks + Jev (hosted) — czekam na ranking";
  return "Źródło: PreStocks API — brak Jev (skonfiguruj API lub BYOK)";
}
