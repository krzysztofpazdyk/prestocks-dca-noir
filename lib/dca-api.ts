/**
 * Client for hosted DCA API.
 * Client TypeSafe BYOK is required for Jev (/rank, /run/dry); empty key must not
 * spend server TYPESAFE. Optional XAI BYOK enables Grok.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import {
  companyDataFromRankMap,
  rememberCompanyRecords,
} from "@/lib/company-data";
import { shown, translate } from "@/lib/i18n";
import { dcaApiBase, readTypesafeKey, readXaiKey } from "@/lib/keys";
import { ensureRuntimeConfig } from "@/lib/runtime-config";
import {
  fetchOwnerUsdcBalance,
  fetchSolBalance,
  rpcUrl,
  usdcMintOrNull,
} from "@/lib/predca";
import {
  filterProducts,
  filterTop3,
  rankPrefsForApi,
  readExclusions,
  readRankPrefs,
  type RankPrefs,
} from "@/lib/rank-prefs";
import {
  NEAR_IPO_NAMES,
  type PrestocksProduct,
  type RankResult,
  type RankRow,
} from "@/lib/universe";

export type LatestRunJson = {
  pipeline?: string[];
  top3?: RankRow[];
  scores?: RankRow[];
  products?: PrestocksProduct[];
  choice?: { choice?: string; confidence?: number | null };
  grok?: { skipped?: boolean; reason?: string; summary?: string };
  premiums_source?: string;
  finished_at_warsaw?: string;
  finished_at_utc?: string;
  mode?: string;
  error?: string;
  company_data?: Record<string, unknown>;
};

const API_TIMEOUT_MS = 8000;
const RANK_TIMEOUT_MS = 60000;

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = API_TIMEOUT_MS,
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    const aborted =
      (typeof DOMException !== "undefined" &&
        e instanceof DOMException &&
        e.name === "AbortError") ||
      (e instanceof Error && e.name === "AbortError");
    if (aborted) {
      throw new Error(`API timeout (${Math.round(timeoutMs / 1000)}s)`);
    }
    const msg = e instanceof Error ? e.message : String(e);
    let host = url;
    try {
      host = new URL(url).host;
    } catch {
      /* keep url */
    }
    if (/Failed to fetch|Load failed|NetworkError/i.test(msg)) {
      throw new Error(shown("rank.err.hostedUnreachable", { host }));
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

function jevUnavailable(): Error {
  return new Error(shown("rank.err.jevUnavailable"));
}

/** A ranking exists only when the pipeline is Jev and the response is ok. */
function jevPipeline(pipeline: string[] | undefined, ok?: boolean): string[] {
  const resolved = Array.isArray(pipeline) ? pipeline : ["prestocks", "jev"];
  if (
    ok === false ||
    !resolved.includes("jev") ||
    resolved.includes("metrics_rank")
  ) {
    throw jevUnavailable();
  }
  return resolved;
}

function mapRunToRank(
  run: LatestRunJson,
  mode: RankResult["mode"],
  sourceLabel: string,
  exclusions?: string[],
): RankResult {
  const pipeline = jevPipeline(run.pipeline, (run as { ok?: boolean }).ok);
  const excl = exclusions ?? readExclusions();
  const products = filterProducts(run.products ?? [], excl);
  const scores = filterProducts((run.scores ?? []) as RankRow[], excl);
  const top3Raw = (run.top3 ?? scores.slice(0, 3)) as RankRow[];
  const top3 = filterTop3(top3Raw, excl);
  const filled =
    top3.length >= 3
      ? top3
      : filterTop3([...(top3 as RankRow[]), ...scores], excl);
  if (
    filled.length < 3 ||
    filled.some((row) => typeof row.score !== "number" || !Number.isFinite(row.score))
  ) {
    throw jevUnavailable();
  }
  return {
    mode,
    sourceLabel,
    pipeline,
    top3: filled,
    scores: scores.length ? scores : filled,
    products,
    choice: run.choice,
    grok: run.grok
      ? {
          skipped: !!run.grok.skipped,
          reason: run.grok.reason,
          summary: run.grok.summary,
        }
      : undefined,
    fetchedAt: run.finished_at_utc ?? new Date().toISOString(),
  };
}

/** Trigger dry-run on backend. Passes BYOK headers when present. */
export async function triggerDryRun(
  exclusions?: string[],
  prefs?: RankPrefs,
): Promise<RankResult> {
  await ensureRuntimeConfig();
  const base = dcaApiBase();
  if (!base) {
    throw new Error(shown("rank.err.noDryApi"));
  }
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  const ts = readTypesafeKey();
  const xai = readXaiKey();
  // Same TypeSafe contract as postRank / API: Bearer + body.typesafe_key
  // (X-Typesafe-Api-Key is ignored by the server after BYOK hardening).
  if (ts) headers.Authorization = `Bearer ${ts}`;
  if (xai) headers["X-Xai-Api-Key"] = xai;
  const apiPrefs = rankPrefsForApi(
    prefs ??
      (exclusions
        ? { ...readRankPrefs(), exclusions }
        : undefined),
  );
  const body = {
    ...apiPrefs,
    ...(ts ? { typesafe_key: ts } : {}),
    ...(xai ? { xai_key: xai } : {}),
  };

  const resp = await fetchWithTimeout(
    `${base}/run/dry`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
    RANK_TIMEOUT_MS,
  );
  const data = (await resp.json()) as {
    ok?: boolean;
    run?: LatestRunJson;
    detail?: unknown;
  };
  if (!resp.ok || data.ok === false) {
    const errMsg =
      (data as { error?: string }).error ||
      (typeof data.detail === "string" ? data.detail : null);
    throw new Error(errMsg || shown("rank.err.jevUnavailable"));
  }
  const run = data.run ?? (data as LatestRunJson);
  const companyRaw =
    run.company_data ??
    (data as { company_data?: Record<string, unknown> }).company_data;
  if (companyRaw) {
    rememberCompanyRecords(companyDataFromRankMap(companyRaw, Date.now()));
  }
  if (!ts) throw jevUnavailable();
  const grok = (run.pipeline ?? []).includes("grok");
  return mapRunToRank(
    run,
    "byok_ai",
    grok ? shown("rank.source.grokJev") : shown("rank.source.jev"),
    apiPrefs.exclusions,
  );
}


export type RankProxyResponse = {
  ok: boolean;
  top3: Array<{ name: string; score: number }>;
  pipeline?: string[];
  error?: string;
  company_data?: Record<string, unknown>;
};

/**
 * CORS-safe ranking via DCA API proxy (Jev with client TypeSafe key).
 * Sends Bearer / body.typesafe_key from localStorage when present.
 * Client key is required for Jev — empty must not imply server spend.
 */
export async function postRank(
  prefs?: RankPrefs,
): Promise<RankProxyResponse> {
  await ensureRuntimeConfig();
  const base = dcaApiBase();
  if (!base) {
    throw new Error(shown("rank.err.noRankProxy"));
  }
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  const ts = readTypesafeKey();
  const xai = readXaiKey();
  if (ts) headers.Authorization = `Bearer ${ts}`;
  if (xai) headers["X-Xai-Api-Key"] = xai;
  const apiPrefs = rankPrefsForApi(prefs);
  const body = {
    ...apiPrefs,
    ...(ts ? { typesafe_key: ts } : {}),
    ...(xai ? { xai_key: xai } : {}),
  };
  const resp = await fetchWithTimeout(
    `${base}/rank`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
    RANK_TIMEOUT_MS,
  );
  let data: RankProxyResponse;
  try {
    data = (await resp.json()) as RankProxyResponse;
  } catch {
    throw new Error(`API /rank HTTP ${resp.status} (nie-JSON)`);
  }
  if (!resp.ok || !data.ok) {
    const detail = (data as RankProxyResponse & { detail?: unknown }).detail;
    throw new Error(
      data.error ||
        (typeof detail === "string" ? detail : `API /rank HTTP ${resp.status}`),
    );
  }
  const excl = (prefs ?? readRankPrefs()).exclusions;
  data.top3 = filterTop3(data.top3 ?? [], excl);
  if (data.company_data) {
    rememberCompanyRecords(companyDataFromRankMap(data.company_data, Date.now()));
  }
  return data;
}

/** Map CORS proxy `/rank` payload onto the shared RankResult shape. */
export function rankResultFromProxy(
  data: RankProxyResponse,
  products: PrestocksProduct[],
  prefs?: Pick<RankPrefs, "premiumsMatter">,
): RankResult {
  const byName = new Map(products.map((p) => [p.name.toLowerCase(), p]));
  const pipeline = jevPipeline(data.pipeline, data.ok);
  const rows: RankRow[] = (data.top3 ?? []).map((r) => {
    const p = byName.get(r.name.toLowerCase());
    const folded = r.name.replace(/\s+/g, "").toLowerCase();
    const base: PrestocksProduct = p ?? {
      name: r.name,
      symbol: r.name.replace(/\s+/g, "").toUpperCase(),
      mint: "",
      token_price_usd: null,
      mark_price_usd: null,
      premium_pct: null,
      premium_source: "proxy",
      near_ipo: NEAR_IPO_NAMES.some(
        (entry) => entry.replace(/\s+/g, "").toLowerCase() === folded,
      ),
    };
    const score = typeof r.score === "number" ? r.score : Number(r.score);
    if (!Number.isFinite(score)) throw jevUnavailable();
    return {
      ...base,
      score,
      score_raw: null,
      confidence: null,
    };
  });
  // Callers still pass premiumsMatter. The ranking note that used it is gone.
  void prefs;
  const grok = pipeline.includes("grok");
  return {
    mode: "byok_ai",
    sourceLabel: grok
      ? shown("rank.source.grokJev")
      : shown("rank.source.jev"),
    pipeline,
    top3: rows.slice(0, 3),
    scores: rows,
    products,
    error: data.error,
    fetchedAt: new Date().toISOString(),
  };
}

export type FaucetUsdcResponse = {
  ok: boolean;
  signature: string;
  amountUi: number;
  mint: string;
  wallet: string;
  ata?: string;
  solSignature?: string | null;
  solAmountUi?: number;
  solSkipped?: boolean;
  solSkipReason?: string;
  error?: string;
  detail?: string;
  /** Set when the POST never confirmed but the wallet balance moved. */
  fundsArrived?: boolean;
};

/** The mint takes up to 90s server-side. Stay past that so the browser is not first to give up. */
export const FAUCET_POST_TIMEOUT_MS = 150_000;
/** How often to re-read the wallet after an ambiguous faucet failure. */
export const FAUCET_CONFIRM_POLL_MS = 3_000;
/** Stop looking for a landed mint after this long. */
export const FAUCET_CONFIRM_MAX_MS = 120_000;
/** One balance read must not hold the faucet button if RPC never answers. */
export const FAUCET_BALANCE_READ_TIMEOUT_MS = 8_000;
/** Demo faucet mints this many mock USDC. */
export const FAUCET_USDC_MIN_INCREASE = 1_000;

const FAUCET_GATEWAY_STATUSES = new Set([502, 504, 524]);

export type FaucetBalanceRead = {
  usdc: number | null;
  sol: number | null;
  /** False when that leg threw. A missing USDC account is null with ok left true. */
  usdcOk?: boolean;
  solOk?: boolean;
};

export type ClaimFaucetOptions = {
  readBalances?: (wallet: string) => Promise<FaucetBalanceRead>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Fires once, when the claim starts re-reading the wallet. */
  onConfirming?: () => void;
  /** Called after a balance increase is accepted as a landed mint. */
  refresh?: () => void | Promise<unknown>;
  postTimeoutMs?: number;
  confirmPollMs?: number;
  confirmMaxMs?: number;
};

type FaucetJson = {
  ok?: boolean;
  signature?: string;
  amountUi?: number;
  mint?: string;
  wallet?: string;
  ata?: string;
  solSignature?: string | null;
  solAmountUi?: number;
  solSkipped?: boolean;
  solSkipReason?: string;
  error?: unknown;
  detail?: unknown;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function balanceKnown(flag: boolean | undefined): boolean {
  return flag !== false;
}

/** USDC up by at least the demo mint, or any SOL increase, against the pre-POST read. */
export function faucetFundsArrived(
  before: FaucetBalanceRead,
  after: FaucetBalanceRead,
): boolean {
  if (balanceKnown(before.usdcOk) && balanceKnown(after.usdcOk)) {
    const from = before.usdc ?? 0;
    const to = after.usdc ?? 0;
    if (to - from >= FAUCET_USDC_MIN_INCREASE) return true;
  }
  if (
    balanceKnown(before.solOk) &&
    balanceKnown(after.solOk) &&
    before.sol != null &&
    after.sol != null &&
    after.sol > before.sol
  ) {
    return true;
  }
  return false;
}

function faucetBodyText(data: FaucetJson | null): string {
  if (!data) return "";
  return [data.detail, data.error]
    .map((value) => {
      if (typeof value === "string") return value;
      if (value == null) return "";
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })
    .join("\n");
}

function faucetFailure(status: number, data: FaucetJson | null): Error {
  if (!data) {
    return new Error(shown("rank.err.faucetNotJson", { status }));
  }
  const detail = data.detail ?? data.error;
  const msg =
    typeof detail === "string"
      ? detail
      : detail != null
        ? JSON.stringify(detail)
        : `API /faucet/usdc HTTP ${status}`;
  return new Error(msg);
}

function isAmbiguousFaucetTransport(err: unknown, url: string): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return true;
  if (/^API timeout \(\d+s\)$/.test(err.message)) return true;
  if (
    /Failed to fetch|Load failed|NetworkError|ECONNRESET|ETIMEDOUT|socket hang up/i.test(
      err.message,
    )
  ) {
    return true;
  }
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* keep the raw url */
  }
  return (
    err.message === translate("pl", "rank.err.hostedUnreachable", { host }) ||
    err.message === translate("en", "rank.err.hostedUnreachable", { host })
  );
}

function shouldConfirmFaucet(status: number, data: FaucetJson | null): boolean {
  if (status === 429) return false;
  if (FAUCET_GATEWAY_STATUSES.has(status)) return true;
  return faucetBodyText(data).includes("Faucet mint timed out");
}

/** One connection for the whole claim. Missing ATA is a known zero, not a failure. */
export async function readFaucetBalances(
  wallet: string,
  connection: Connection,
): Promise<FaucetBalanceRead> {
  const owner = new PublicKey(wallet);
  const mint = usdcMintOrNull();
  const read: FaucetBalanceRead = {
    usdc: null,
    sol: null,
    usdcOk: false,
    solOk: false,
  };
  if (mint) {
    try {
      read.usdc = await fetchOwnerUsdcBalance(connection, owner, mint);
      read.usdcOk = true;
    } catch {
      read.usdcOk = false;
    }
  }
  try {
    read.sol = await fetchSolBalance(connection, owner);
    read.solOk = true;
  } catch {
    read.solOk = false;
  }
  return read;
}

function defaultBalanceReader(): (wallet: string) => Promise<FaucetBalanceRead> {
  const connection = new Connection(rpcUrl(), "confirmed");
  return (wallet) => readFaucetBalances(wallet, connection);
}

/** A gateway 504 can leave the body stream open. Do not wait on it. */
export async function cancelFaucetBody(resp: Response): Promise<void> {
  const body = resp.body;
  if (!body) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 500);
    body.cancel().then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

async function readFaucetBalanceCapped(
  wallet: string,
  read: (wallet: string) => Promise<FaucetBalanceRead>,
  timeoutMs: number,
): Promise<FaucetBalanceRead> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(wallet),
      new Promise<FaucetBalanceRead>((resolve) => {
        timer = setTimeout(() => {
          resolve({ usdc: null, sol: null, usdcOk: false, solOk: false });
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function arrivedResponse(wallet: string): FaucetUsdcResponse {
  return {
    ok: true,
    signature: "",
    amountUi: FAUCET_USDC_MIN_INCREASE,
    mint: "",
    wallet,
    fundsArrived: true,
  };
}

async function confirmFaucetByBalance(
  wallet: string,
  before: FaucetBalanceRead,
  read: (wallet: string) => Promise<FaucetBalanceRead>,
  options: {
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    pollMs: number;
    maxMs: number;
    onConfirming?: () => void;
    refresh?: () => void | Promise<unknown>;
  },
): Promise<FaucetUsdcResponse> {
  options.onConfirming?.();
  const started = options.now();
  const pollMs = Math.max(1, options.pollMs);
  const maxChecks = Math.floor(options.maxMs / pollMs) + 1;
  let checks = 0;
  while (checks < maxChecks) {
    checks += 1;
    let after: FaucetBalanceRead;
    try {
      after = await readFaucetBalanceCapped(wallet, read, FAUCET_BALANCE_READ_TIMEOUT_MS);
    } catch {
      after = { usdc: null, sol: null, usdcOk: false, solOk: false };
    }
    if (faucetFundsArrived(before, after)) {
      try {
        await options.refresh?.();
      } catch {
        /* a landed mint still counts if the follow-up refresh fails */
      }
      return arrivedResponse(wallet);
    }
    const elapsed = options.now() - started;
    if (elapsed >= options.maxMs) break;
    const wait = Math.min(pollMs, options.maxMs - elapsed);
    if (wait <= 0) break;
    await options.sleep(wait);
  }
  throw new Error(shown("faucet.unconfirmed"));
}

/** Devnet demo faucet: mint 1000 mock USDC + 0.1 SOL (if needed) to the wallet. */
export async function claimFaucetUsdc(
  wallet: string,
  options: ClaimFaucetOptions = {},
): Promise<FaucetUsdcResponse> {
  await ensureRuntimeConfig();
  const base = dcaApiBase();
  if (!base) {
    throw new Error(shown("rank.err.noFaucet"));
  }
  const read = options.readBalances ?? defaultBalanceReader();
  const sleep = options.sleep ?? delay;
  const now = options.now ?? Date.now;
  const postTimeoutMs = options.postTimeoutMs ?? FAUCET_POST_TIMEOUT_MS;
  const confirmPollMs = options.confirmPollMs ?? FAUCET_CONFIRM_POLL_MS;
  const confirmMaxMs = options.confirmMaxMs ?? FAUCET_CONFIRM_MAX_MS;

  let before: FaucetBalanceRead;
  try {
    before = await read(wallet);
  } catch {
    before = { usdc: null, sol: null, usdcOk: false, solOk: false };
  }

  const url = `${base}/faucet/usdc`;
  let resp: Response;
  try {
    resp = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ wallet }),
      },
      postTimeoutMs,
    );
  } catch (err) {
    if (!isAmbiguousFaucetTransport(err, url)) throw err;
    return confirmFaucetByBalance(wallet, before, read, {
      sleep,
      now,
      pollMs: confirmPollMs,
      maxMs: confirmMaxMs,
      onConfirming: options.onConfirming,
      refresh: options.refresh,
    });
  }

  if (FAUCET_GATEWAY_STATUSES.has(resp.status)) {
    await cancelFaucetBody(resp);
    return confirmFaucetByBalance(wallet, before, read, {
      sleep,
      now,
      pollMs: confirmPollMs,
      maxMs: confirmMaxMs,
      onConfirming: options.onConfirming,
      refresh: options.refresh,
    });
  }

  let data: FaucetJson | null = null;
  try {
    data = (await resp.json()) as FaucetJson;
  } catch {
    data = null;
  }

  if (resp.ok && data?.ok === true) {
    return data as FaucetUsdcResponse;
  }
  if (resp.status === 429) {
    throw faucetFailure(resp.status, data);
  }
  if (shouldConfirmFaucet(resp.status, data)) {
    return confirmFaucetByBalance(wallet, before, read, {
      sleep,
      now,
      pollMs: confirmPollMs,
      maxMs: confirmMaxMs,
      onConfirming: options.onConfirming,
      refresh: options.refresh,
    });
  }
  if (!data) {
    throw new Error(shown("rank.err.faucetNotJson", { status: resp.status }));
  }
  throw faucetFailure(resp.status, data);
}

