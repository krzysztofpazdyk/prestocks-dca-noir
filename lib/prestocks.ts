/**
 * Live PreStocks public APIs (no keys) — the ranking input when Grok is absent.
 * Prefer same-origin /api/prestocks/live (next dev) so CORS cannot block
 * prestocks.com. Then direct → DCA API → session → Jupiter only, else no data.
 */

import {
  applyCompanyData,
  companyDataFromProducts,
  rememberCompanyRecords,
} from "@/lib/company-data";
import {
  canonicalName,
  fetchJupPrices,
  ipoPremiumPct,
  premiumBasisUsd,
  quoteByName,
  readJupPriceCache,
  type JupPrices,
  type JupQuote,
} from "@/lib/jup-prices";
import { canUseSameOriginJevProxy, dcaApiBase, SS_PRODUCTS } from "@/lib/keys";
import { ensureRuntimeConfig } from "@/lib/runtime-config";
import {
  MINTS,
  NEAR_IPO_NAMES,
  SYMBOL_BY_NAME,
  XAI_MINT,
  type PrestocksProduct,
} from "@/lib/universe";

const ORIGIN = "https://prestocks.com";

export type ProductNoticeVars = {
  detail?: string;
  detailKey?: string;
  date?: string;
};

export type ProductsFetchResult = {
  products: PrestocksProduct[];
  totals: unknown;
  premiumsSource: string;
  dataSource: "live" | "live_proxy" | "api_proxy" | "session" | "jupiter_only" | "none";
  corsError: boolean;
  /** Older callers and a saved Polish sentence. New notes use errorKey. */
  errorPl: string | null;
  errorKey?: string | null;
  errorVars?: ProductNoticeVars;
};

/** Resolve a nested detail key when the note is shown. No locale import here. */
export function fillNoticeVars(
  vars: ProductNoticeVars | undefined,
  t: (key: string, vars?: Record<string, string | number>) => string,
): Record<string, string> {
  if (!vars) return {};
  const out: Record<string, string> = {};
  if (vars.detailKey) out.detail = t(vars.detailKey);
  else if (vars.detail != null) out.detail = vars.detail;
  if (vars.date != null) out.date = vars.date;
  return out;
}

const DEADLINE_DATE_KEYS = [
  "expires_at",
  "expiry",
  "expiry_date",
  "deadline",
  "deadline_at",
] as const;

const DEADLINE_BOOL_KEYS = [
  "deadline_invalid",
  "deadlineInvalid",
  "expired",
  "is_expired",
  "isExpired",
] as const;

/** Parse a metrics/API date without inventing one. Unix seconds or ms, or ISO. */
export function parseDeadlineMs(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw < 1e12 ? raw * 1000 : raw;
  }
  if (typeof raw === "string") {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/** First known expiry date from metrics. Missing keys = no deadline. */
export function deadlineAtFromMetrics(
  m: Record<string, unknown>,
): number | null {
  for (const key of DEADLINE_DATE_KEYS) {
    if (!(key in m) || m[key] == null || m[key] === "") continue;
    const ms = parseDeadlineMs(m[key]);
    if (ms != null) return ms;
  }
  return null;
}

function deadlineFlagFromMetrics(
  m: Record<string, unknown>,
): boolean | null {
  for (const key of DEADLINE_BOOL_KEYS) {
    if (!(key in m) || m[key] == null) continue;
    const v = m[key];
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      if (["1", "true", "yes", "on", "expired", "invalid"].includes(s)) {
        return true;
      }
      if (["0", "false", "no", "off", "valid", "ok"].includes(s)) {
        return false;
      }
    }
  }
  return null;
}

/**
 * Map optional metrics expiry/deadline signals → deadline_invalid (do not invent).
 * A known date wins over a boolean flag: past date = expired, future date = not.
 */
export function deadlineInvalidFromMetrics(
  m: Record<string, unknown>,
  now = Date.now(),
): boolean {
  const at = deadlineAtFromMetrics(m);
  if (at != null) return at < now;
  return deadlineFlagFromMetrics(m) === true;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function positivePrice(v: unknown): number | null {
  if (typeof v === "boolean" || v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/** Live Jupiter when any name has it. Otherwise there is no premium figure. */
export function summarizePremiumSource(products: PrestocksProduct[]): string {
  if (products.some((p) => p.premium_source === "jupiter_stockdata")) {
    return "jupiter_stockdata";
  }
  return "no_data";
}

export function buildProducts(
  metrics: Array<Record<string, unknown>>,
  quotes: Record<string, JupQuote>,
  now = Date.now(),
): PrestocksProduct[] {
  const byMint = new Map<string, Record<string, unknown>>();
  for (const m of metrics) {
    const mint = (m.splMint as string | undefined) ?? undefined;
    if (mint) byMint.set(mint, m);
  }

  const out: PrestocksProduct[] = [];
  for (const [name, mint] of Object.entries(MINTS)) {
    if (mint === XAI_MINT) continue;
    const m = byMint.get(mint) ?? {};
    const sym = SYMBOL_BY_NAME[name];
    const quote = quotes[name];
    const tokenPrice = positivePrice(m.tokenPrice) ?? quote?.usdPrice ?? null;
    const premium = quote ? ipoPremiumPct(quote, now) : null;
    const basis = quote ? premiumBasisUsd(quote, now) : null;
    let premium_pct: number | null;
    let premium_source: string;
    let markOut: number | null = null;
    if (premium != null && basis != null) {
      premium_pct = round3(premium);
      premium_source = "jupiter_stockdata";
      markOut = basis;
    } else {
      premium_pct = null;
      premium_source = "no_data";
    }
    out.push({
      name,
      symbol: sym,
      mint,
      token_price_usd: tokenPrice != null ? round6(tokenPrice) : null,
      mark_price_usd: markOut != null ? round6(markOut) : null,
      premium_pct,
      premium_source,
      market_cap_usd: (m.marketCapUSD as number) ?? null,
      holders: (m.holderCount as number) ?? null,
      volume_cum_usd: (m.cumulativeVolumeUSD as number) ?? null,
      txn_count: (m.txnCount as number) ?? null,
      change_30d_pct: (m.thirtyDayChange as number) ?? null,
      near_ipo: NEAR_IPO_NAMES.some((entry) => entry === name),
      ipo_completed: Boolean(
        m.ipo_completed ?? m.ipoCompleted ?? false,
      ),
      deadline_at: deadlineAtFromMetrics(m),
      deadline_invalid: deadlineInvalidFromMetrics(m, now),
    });
  }
  return out;
}

/**
 * Overlay a Jupiter quote onto products that already exist (API proxy or an earlier list).
 * Premium and mark move only when `ipoPremiumPct` is a number.
 * SpaceX mark is the post-IPO reference (SPCXx, else SPCX), not the frozen stock quote.
 * `replaceTokenPrice` writes `usdPrice` even when the product already has one.
 * Otherwise token price is filled only when missing.
 */
export function applyJupPremiums(
  products: PrestocksProduct[],
  quotes: Record<string, JupQuote>,
  now: number,
  opts?: { replaceTokenPrice?: boolean },
): PrestocksProduct[] {
  return products.map((p) => {
    const q = quoteByName(quotes, p.name);
    if (!q) return p;
    const next: PrestocksProduct = { ...p };
    let changed = false;
    if (q.usdPrice != null && (opts?.replaceTokenPrice || !(p.token_price_usd != null && p.token_price_usd > 0))) {
      next.token_price_usd = round6(q.usdPrice);
      changed = true;
    }
    const premium = ipoPremiumPct(q, now);
    const basis = premiumBasisUsd(q, now);
    if (premium != null && basis != null) {
      next.mark_price_usd = round6(basis);
      next.premium_pct = round3(premium);
      next.premium_source = "jupiter_stockdata";
      changed = true;
    }
    return changed ? next : p;
  });
}

async function fetchJson(url: string, timeoutMs = 8000): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      headers: { Accept: "application/json" },
      mode: "cors",
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${url}`);
    return resp.json();
  } catch (e) {
    const aborted =
      (typeof DOMException !== "undefined" &&
        e instanceof DOMException &&
        e.name === "AbortError") ||
      (e instanceof Error && e.name === "AbortError");
    if (aborted) throw new Error(`timeout ${url}`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

/** Live fetch from prestocks.com metrics + Jupiter Price API v3. Used by /api/prestocks/live. */
export async function loadLivePrestocks(prices?: Promise<JupPrices>): Promise<{
  products: PrestocksProduct[];
  totals: unknown;
  premiumsSource: string;
}> {
  const [metricsPayload, jup] = await Promise.all([
    fetchJson(`${ORIGIN}/api/metrics`) as Promise<{
      metrics?: Array<Record<string, unknown>>;
      totals?: unknown;
    }>,
    prices ?? fetchJupPrices(),
  ]);
  const metrics = metricsPayload.metrics ?? [];
  const products = buildProducts(metrics, jup.quotes, jup.fetchedAt);
  return {
    products,
    totals: metricsPayload.totals,
    premiumsSource: summarizePremiumSource(products),
  };
}

async function fetchViaApiProxy(prices?: Promise<JupPrices>): Promise<{
  products: PrestocksProduct[];
  totals: unknown;
  premiumsSource: string;
} | null> {
  const base = dcaApiBase();
  if (!base) return null;
  const data = (await fetchJson(`${base}/prestocks/products`)) as {
    products: PrestocksProduct[];
    totals?: unknown;
    premiums_source?: string;
  };
  const products = (data.products ?? []).filter((p) => p.mint !== XAI_MINT);
  let premiumsSource = data.premiums_source ?? "api_proxy";
  try {
    const jup = await (prices ?? fetchJupPrices());
    const overlaid = applyJupPremiums(products, jup.quotes, jup.fetchedAt);
    if (overlaid.some((p) => p.premium_source === "jupiter_stockdata")) {
      premiumsSource = "jupiter_stockdata";
    }
    return { products: overlaid, totals: data.totals, premiumsSource };
  } catch {
    return { products, totals: data.totals, premiumsSource };
  }
}

function readSession(): PrestocksProduct[] | null {
  try {
    const raw = sessionStorage.getItem(SS_PRODUCTS);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PrestocksProduct[];
    return Array.isArray(parsed) && parsed.length ? parsed : null;
  } catch {
    return null;
  }
}

function writeSession(products: PrestocksProduct[]) {
  try {
    sessionStorage.setItem(SS_PRODUCTS, JSON.stringify(products));
  } catch {
    /* ignore */
  }
}

function localLiveProxyUrl(): string | null {
  if (typeof window === "undefined") return null;
  const base = (
    process.env.NEXT_PUBLIC_BASE_PATH || "/prestocks-dca-noir"
  ).replace(/\/$/, "");
  return `${window.location.origin}${base}/api/prestocks/live/`;
}

function listedNearIpo(name: string): boolean {
  const want = canonicalName(name);
  return NEAR_IPO_NAMES.some((entry) => canonicalName(entry) === want);
}

function finishProducts(products: PrestocksProduct[]): PrestocksProduct[] {
  const now = Date.now();
  // Server flags are not a source. Only the client list, then fresh company data.
  const grounded = products.map((product) => {
    const extra = product as PrestocksProduct & Record<string, unknown>;
    const deadlineAt =
      typeof product.deadline_at === "number" && Number.isFinite(product.deadline_at)
        ? product.deadline_at
        : deadlineAtFromMetrics(extra);
    const deadlineInvalid =
      deadlineAt != null && deadlineAt < now
        ? true
        : product.deadline_invalid;
    return {
      ...product,
      near_ipo: listedNearIpo(product.name),
      deadline_at: deadlineAt ?? product.deadline_at,
      deadline_invalid: deadlineInvalid,
    };
  });
  const incoming = companyDataFromProducts(grounded, now);
  const byName = rememberCompanyRecords(incoming, now);
  return applyCompanyData(grounded, byName, now);
}

function skipDirectPrestocks(): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  return host !== "localhost" && host !== "127.0.0.1" && host !== "::1";
}

/** Same-origin proxy only on localhost. Elsewhere skip prestocks.com and reuse one Jupiter read. */
export async function fetchPrestocksProducts(
  prices?: JupPrices,
): Promise<ProductsFetchResult> {
  await ensureRuntimeConfig();
  let inflight: Promise<JupPrices> | null = null;
  const pricesOnce = (): Promise<JupPrices> => {
    if (!inflight) {
      inflight =
        prices && prices.fetchedAt > 0 ? Promise.resolve(prices) : fetchJupPrices();
    }
    return inflight;
  };

  const proxyUrl = canUseSameOriginJevProxy() ? localLiveProxyUrl() : null;
  if (proxyUrl) {
    try {
      const data = (await fetchJson(proxyUrl, 20000)) as {
        ok?: boolean;
        products?: PrestocksProduct[];
        totals?: unknown;
        premiumsSource?: string;
      };
      if (data.ok && (data.products?.length ?? 0) >= 3) {
        const products = finishProducts(data.products ?? []);
        writeSession(products);
        return {
          products,
          totals: data.totals,
          premiumsSource: data.premiumsSource ?? "live_mark_price_batch",
          dataSource: "live_proxy",
          corsError: false,
          errorPl: null,
        };
      }
    } catch {
      /* fall through */
    }
  }

  let directDetailKey: string | null = "prestocks.skippedDirect";
  let directDetail = "";
  let looksCors = false;
  if (!skipDirectPrestocks()) {
    try {
      const live = await loadLivePrestocks(pricesOnce());
      const products = finishProducts(live.products);
      writeSession(products);
      return {
        products,
        totals: live.totals,
        premiumsSource: live.premiumsSource,
        dataSource: "live",
        corsError: false,
        errorPl: null,
      };
    } catch (e) {
      directDetailKey = null;
      directDetail = e instanceof Error ? e.message : String(e);
      looksCors =
        /Failed to fetch|NetworkError|CORS|blocked|Load failed/i.test(directDetail) ||
        directDetail === "Failed to fetch";
    }
  }

  try {
    const proxied = await fetchViaApiProxy(pricesOnce());
    if (proxied && proxied.products.length) {
      const products = finishProducts(proxied.products);
      writeSession(products);
      return {
        products,
        totals: proxied.totals,
        premiumsSource: proxied.premiumsSource,
        dataSource: "api_proxy",
        corsError: looksCors,
        errorPl: null,
        errorKey: looksCors ? "prestocks.corsProxy" : null,
      };
    }
  } catch {
    /* continue */
  }

  const sess = readSession();
  if (sess) {
    return {
      products: finishProducts(sess),
      totals: null,
      premiumsSource: "sessionStorage",
      dataSource: "session",
      corsError: looksCors,
      errorPl: null,
      errorKey: "prestocks.sessionFallback",
    };
  }

  const fromJupiter = await jupiterOnlyQuotes(pricesOnce);
  if (fromJupiter) {
    const products = finishProducts(
      buildProducts([], fromJupiter.quotes, fromJupiter.fetchedAt),
    );
    return {
      products,
      totals: null,
      premiumsSource: summarizePremiumSource(products),
      dataSource: "jupiter_only",
      corsError: looksCors,
      errorPl: null,
    };
  }

  return {
    products: finishProducts([]),
    totals: null,
    premiumsSource: "none",
    dataSource: "none",
    corsError: looksCors,
    errorPl: null,
    errorKey: "prestocks.snapshotError",
    errorVars: directDetailKey
      ? { detailKey: directDetailKey }
      : { detail: directDetail },
  };
}

/** A quote set we can turn into the 8 names. Blank shells are not a read. */
function quotesWithMarket(
  quotes: Record<string, JupQuote> | null | undefined,
): Record<string, JupQuote> | null {
  if (!quotes) return null;
  const any = Object.values(quotes).some(
    (q) =>
      q != null &&
      (q.usdPrice != null ||
        q.stockPrice != null ||
        q.refUsdPrice != null ||
        q.refBackupUsdPrice != null),
  );
  return any ? quotes : null;
}

/**
 * Eight names from the Jupiter read already in flight.
 * A failed read uses the price cache. Neither → null (caller returns no products).
 */
async function jupiterOnlyQuotes(
  pricesOnce: () => Promise<JupPrices>,
): Promise<{ quotes: Record<string, JupQuote>; fetchedAt: number } | null> {
  try {
    const jup = await pricesOnce();
    const quotes = quotesWithMarket(jup.quotes);
    if (quotes) return { quotes, fetchedAt: jup.fetchedAt };
  } catch {
    /* try the cache */
  }
  const cached = readJupPriceCache();
  const quotes = quotesWithMarket(cached?.quotes);
  if (!cached || !quotes) return null;
  return { quotes, fetchedAt: cached.fetchedAt };
}
