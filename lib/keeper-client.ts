/**
 * Predca keeper client — public HTTPS (rank API /keeper proxy).
 * Status and prefs are a public read for one wallet (`GET /public/status`).
 * A wallet signature is required only for enable, disable, and prefs.
 */

import { readTypesafeKey } from "@/lib/keys";
import {
  ensureRuntimeConfig,
  runtimeDcaApiUrl,
  runtimeKeeperUrl,
} from "@/lib/runtime-config";

const DEFAULT_KEEPER = "http://127.0.0.1:8792";

/**
 * runtime keeperUrl, else runtime API + /keeper,
 * else NEXT_PUBLIC_KEEPER_URL, else NEXT_PUBLIC_DCA_API_URL + /keeper,
 * else local default.
 */
export function keeperUrl(): string {
  const runtimeKeeper = runtimeKeeperUrl().trim().replace(/\/$/, "");
  if (runtimeKeeper) return runtimeKeeper;
  const runtimeDca = runtimeDcaApiUrl().trim().replace(/\/$/, "");
  if (runtimeDca) return `${runtimeDca}/keeper`;
  const fromEnv = (process.env.NEXT_PUBLIC_KEEPER_URL ?? "").trim().replace(/\/$/, "");
  if (fromEnv) return fromEnv;
  const dca = (process.env.NEXT_PUBLIC_DCA_API_URL ?? "").trim().replace(/\/$/, "");
  if (dca) return `${dca}/keeper`;
  return DEFAULT_KEEPER;
}

export type KeeperMode = "live" | "dry-run";

export type KeeperRunResult = {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  signature?: string;
  names?: string[];
  amountUsd?: number;
  error?: string;
  nextAt?: string | number;
  /** Keeper/on-chain schedule aliases used by older status payloads. */
  next_buy_at?: string | number;
  lastRunTs?: string | number;
  last_run_ts?: string | number;
  lastBuy?: string | number;
  last_buy?: string | number;
  interval?: string | number;
  intervalSec?: string | number;
  interval_sec?: string | number;
  enabled?: boolean;
  owner?: string;
  phase?: string;
  source?: "daemon" | "file" | string;
  daemon?: boolean;
  /** live = real execute_buy; dry-run = no txs (must match daemon gate). */
  mode?: KeeperMode | string;
  detail?: string;
  /** Client gave up waiting. The daemon may still finish /enable. */
  pending?: boolean;
  /** Ranking prefs from the public status read. Never includes a Jev key. */
  prefs?: KeeperPrefsPayload;
  /** True when the keeper has a Jev key stored. The key itself is never returned. */
  hasJevKey?: boolean;
};

export type KeeperPrefsPayload = {
  exclusions?: string[];
  deadlines_unimportant?: boolean;
  premiums_matter?: boolean;
  premiums_especially_near_ipo?: boolean;
  buy_despite_ipo?: boolean;
};

export type KeeperSignFn = (message: Uint8Array) => Promise<Uint8Array>;

const SIG_TTL_S = 5 * 60;

function bytesToBase58(bytes: Uint8Array): string {
  const ALPH = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [0];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (let i = 0; i < zeros; i++) out += "1";
  for (let i = digits.length - 1; i >= 0; i--) out += ALPH[digits[i]];
  return out;
}

/** Cleartext message the proxy verifies (action + owner + expiry). */
export function buildKeeperAuthMessage(action: string, owner: string): string {
  const expires = Math.floor(Date.now() / 1000) + SIG_TTL_S;
  return [
    "Predca keeper authorization",
    `action:${action}`,
    `owner:${owner}`,
    `expires:${expires}`,
  ].join("\n");
}

export async function signKeeperAuth(
  signMessage: KeeperSignFn,
  action: string,
  owner: string,
): Promise<{ wallet: string; message: string; signature: string; owner: string }> {
  const message = buildKeeperAuthMessage(action, owner);
  const sig = await signMessage(new TextEncoder().encode(message));
  return {
    wallet: owner,
    owner,
    message,
    signature: bytesToBase58(sig),
  };
}

/**
 * Older builds kept a bearer token under this prefix (localStorage, then
 * sessionStorage). Status no longer uses a session. Delete the keys.
 * Never read or log the values.
 */
export const KEEPER_SESSION_PREFIX = "noir3.predca.keeper.session.";

function purgeStoragePrefix(storage: Storage | undefined): void {
  if (!storage) return;
  try {
    const prefix = KEEPER_SESSION_PREFIX;
    for (let i = storage.length - 1; i >= 0; i--) {
      const k = storage.key(i);
      if (k && k.startsWith(prefix)) storage.removeItem(k);
    }
  } catch {
    /* private mode */
  }
}

/** Drop leftover keeper session tokens. Does not read or log them. */
export function purgeStoredKeeperSessions(): void {
  if (typeof localStorage !== "undefined") purgeStoragePrefix(localStorage);
  if (typeof sessionStorage !== "undefined") purgeStoragePrefix(sessionStorage);
}

purgeStoredKeeperSessions();

/**
 * Wallet change and disconnect still call this. There is no status signature
 * cache left; the call only deletes leftover session tokens.
 */
export function clearStatusAuthCache(_owner?: string): void {
  purgeStoredKeeperSessions();
}

/** Abort from our timeout, not a daemon answer. */
export function isKeeperTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = "name" in err ? (err as { name?: unknown }).name : "";
  return name === "AbortError" || name === "TimeoutError";
}

export type KeeperTransport = {
  ok: boolean;
  status: number;
  data: KeeperRunResult | null;
  timedOut: boolean;
};

const ENABLE_PROXY_PENDING_STATUS = new Set([408, 502, 504, 524]);
const ENABLE_PROXY_TIMEOUT_RE = /timeout|unreachable/i;
const ENABLE_UNKNOWN_ERROR_RE =
  /not confirmed|TransactionExpiredTimeout|unknown if it succeeded/i;

function transportSaysUnknownEnable(data: KeeperRunResult): boolean {
  if (data.pending === true) return true;
  if (typeof data.signature === "string" && data.signature.length > 0) return true;
  if (data.reason === "confirming" || data.reason === "recent_run") return true;
  return ENABLE_UNKNOWN_ERROR_RE.test(data.error ?? "");
}

/**
 * No HTTP body and a timeout or status 0 means the daemon may still be
 * inside /enable. A confirm timeout, recent run, or proxy 502/504/524 is the
 * same: pending, not a failed buy. 401/403 stay hard errors.
 */
export function enableResultFromTransport(r: KeeperTransport): KeeperRunResult {
  if (r.status === 401 || r.status === 403) {
    return {
      ok: false,
      error: r.data?.error || r.data?.detail || "signature_rejected",
    };
  }
  if (ENABLE_PROXY_PENDING_STATUS.has(r.status)) {
    return { ok: false, pending: true, error: "enable_timeout" };
  }
  const data = r.data;
  if (data && data.ok !== true) {
    const blob = `${data.error ?? ""} ${data.detail ?? ""}`;
    if (ENABLE_PROXY_TIMEOUT_RE.test(blob)) {
      return {
        ...data,
        ok: false,
        pending: true,
        error: data.error || data.detail || "enable_timeout",
      };
    }
    if (data.ok === false && transportSaysUnknownEnable(data)) {
      return {
        ...data,
        ok: false,
        pending: true,
        error: data.error || "enable_timeout",
      };
    }
  }
  if (!data) {
    if (r.timedOut || r.status === 0) {
      return { ok: false, pending: true, error: "enable_timeout" };
    }
    return { ok: false, error: `http_${r.status}` };
  }
  if (!r.ok) {
    return {
      ok: false,
      error: data.error || data.detail || `http_${r.status}`,
    };
  }
  return data;
}

async function keeperFetch(
  path: string,
  init?: RequestInit,
  timeoutMs = 90000,
): Promise<KeeperTransport> {
  await ensureRuntimeConfig();
  const ctrl = new AbortController();
  const t = window.setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${keeperUrl()}${path}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
      },
      signal: ctrl.signal,
    });
    let data: KeeperRunResult | null = null;
    try {
      data = (await resp.json()) as KeeperRunResult;
    } catch {
      data = null;
    }
    if (!resp.ok && data && !data.error) {
      const detail =
        typeof (data as { detail?: unknown }).detail === "string"
          ? String((data as { detail: string }).detail)
          : undefined;
      data = {
        ...data,
        ok: false,
        error: detail || data.error || `http_${resp.status}`,
      };
    }
    return { ok: resp.ok, status: resp.status, data, timedOut: false };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      data: null,
      timedOut: isKeeperTimeoutError(err),
    };
  } finally {
    window.clearTimeout(t);
  }
}

function parseKeeperMode(raw: unknown): KeeperMode | null {
  if (raw === "live" || raw === "dry-run") return raw;
  return null;
}

/** Public keeper /health — ok + trade mode (same flag as buy path). */
export async function keeperHealthInfo(): Promise<{
  ok: boolean;
  mode: KeeperMode | null;
}> {
  const r = await keeperFetch("/health", { method: "GET" }, 5000);
  if (!r.ok) return { ok: false, mode: null };
  const mode = parseKeeperMode(r.data?.mode) ?? "live";
  return { ok: true, mode };
}

export async function keeperHealth(): Promise<boolean> {
  const info = await keeperHealthInfo();
  return info.ok;
}

export async function keeperRegister(
  owner: string,
  signMessage: KeeperSignFn,
): Promise<boolean> {
  const auth = await signKeeperAuth(signMessage, "register", owner);
  const r = await keeperFetch(
    "/register",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(auth),
    },
    15000,
  );
  return r.ok;
}

export async function keeperRun(
  force: boolean,
  owner: string,
  signMessage: KeeperSignFn,
): Promise<KeeperRunResult> {
  const auth = await signKeeperAuth(signMessage, "run", owner);
  const r = await keeperFetch(
    "/run",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...auth, force }),
    },
    120000,
  );
  if (!r.data) return { ok: false, error: "keeper_unreachable" };
  return r.data;
}

/** Top-level POST field. Omitted when the settings field is empty. Never a URL. */
function typesafeKeyJson(): { typesafe_key: string } | Record<string, never> {
  const key = readTypesafeKey();
  if (!key) return {};
  return { typesafe_key: key };
}

export async function keeperEnable(
  owner: string,
  force = true,
  signMessage?: KeeperSignFn,
  prefs?: KeeperPrefsPayload,
): Promise<KeeperRunResult> {
  if (!signMessage) {
    return { ok: false, error: "wallet_signature_required" };
  }
  let auth;
  try {
    auth = await signKeeperAuth(signMessage, "enable", owner);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `sign_rejected: ${msg}` };
  }
  // Client timeout stays 120s. Proxy /enable is longer: 5s rank, then the
  // buy, then about 90s waiting for confirmation. When this call ends first,
  // a 408/502/504/524, a client timeout, or a "timeout|unreachable" body is
  // pending (enableResultFromTransport) and the UI polls status instead of
  // turning the switch off.
  const r = await keeperFetch(
    "/enable",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...auth,
        force,
        ...(prefs ? { prefs } : {}),
        ...typesafeKeyJson(),
      }),
    },
    120000,
  );
  return withPublicRefresh(owner, enableResultFromTransport(r));
}

export async function keeperDisable(
  owner: string,
  signMessage?: KeeperSignFn,
): Promise<KeeperRunResult> {
  if (!signMessage) {
    return { ok: false, error: "wallet_signature_required" };
  }
  let auth;
  try {
    auth = await signKeeperAuth(signMessage, "disable", owner);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `sign_rejected: ${msg}` };
  }
  const r = await keeperFetch(
    "/disable",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(auth),
    },
    15000,
  );
  if (!r.data) {
    return {
      ok: false,
      error: r.status === 0 ? "keeper_unreachable" : `http_${r.status}`,
    };
  }
  if (!r.ok || r.status === 401 || r.status === 403 || r.data.ok === false) {
    return {
      ok: false,
      error:
        r.data.error ||
        r.data.detail ||
        (r.status === 401 || r.status === 403
          ? "signature_rejected"
          : `http_${r.status}`),
    };
  }
  return withPublicRefresh(owner, { ...r.data, ok: true });
}

/**
 * Timestamps on a keeper status payload.
 */
function timestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const numeric = Number(value.trim());
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function intervalMs(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  // Keeper intervals are normally seconds; accept milliseconds for API variants.
  return seconds < 1e10 ? seconds * 1000 : seconds;
}

/**
 * Resolve the next purchase from keeper status, tolerating current and legacy
 * snake_case payloads, then fall back to the on-chain RunRecord timestamp.
 */
export function keeperNextBuyAtMs(
  status: KeeperRunResult,
  fallbackLastBuyTs?: number | null,
): number | null {
  const direct = [status.nextAt, status.next_buy_at]
    .map(timestampMs)
    .find((value): value is number => value != null);
  if (direct != null) return direct;

  const lastBuy = [
    status.lastRunTs,
    status.last_run_ts,
    status.lastBuy,
    status.last_buy,
  ]
    .map(timestampMs)
    .find((value): value is number => value != null)
    ?? timestampMs(fallbackLastBuyTs);
  if (lastBuy == null) return null;

  const interval = [status.intervalSec, status.interval_sec, status.interval]
    .map(intervalMs)
    .find((value): value is number => value != null);
  return lastBuy + (interval ?? 7 * 24 * 60 * 60 * 1000);
}

const TRANSITIONAL_PUBLIC_PHASES = new Set([
  "enabling",
  "buying",
  "checking",
  "ranking",
  "confirming",
  "pending",
]);

/** enabled:false with no settled phase must not be treated as Off. */
function publicReadIsTransitional(st: {
  enabled?: boolean;
  phase?: string | null;
}): boolean {
  if (typeof st.enabled !== "boolean") return true;
  if (st.enabled === true) return false;
  const phase = typeof st.phase === "string" ? st.phase.trim() : "";
  if (!phase) return true;
  return TRANSITIONAL_PUBLIC_PHASES.has(phase);
}

/**
 * After a successful enable, disable, or prefs push, re-read public status.
 * A failed read keeps the action body. A transitional enabled:false does not
 * replace the action's on/off bit. Purchase fields stay on the action result.
 */
async function withPublicRefresh(
  owner: string,
  action: KeeperRunResult,
): Promise<KeeperRunResult> {
  if (!action.ok || action.pending) return action;
  const fresh = await keeperPublicStatus(owner);
  if (!fresh.ok) return action;
  const transitional = publicReadIsTransitional(fresh);
  return {
    ...action,
    owner: fresh.owner ?? action.owner,
    mode: fresh.mode ?? action.mode,
    nextAt: fresh.nextAt ?? action.nextAt,
    next_buy_at: fresh.next_buy_at ?? action.next_buy_at,
    lastRunTs: fresh.lastRunTs ?? action.lastRunTs,
    last_run_ts: fresh.last_run_ts ?? action.last_run_ts,
    prefs: fresh.prefs ?? action.prefs,
    hasJevKey:
      typeof fresh.hasJevKey === "boolean" ? fresh.hasJevKey : action.hasJevKey,
    phase: transitional ? (action.phase ?? fresh.phase) : (fresh.phase ?? action.phase),
    enabled: transitional
      ? action.enabled
      : typeof fresh.enabled === "boolean"
        ? fresh.enabled
        : action.enabled,
    signature: action.signature || fresh.signature,
  };
}

const PUBLIC_TEXT_FIELDS = [
  "signature",
  "nextAt",
  "next_buy_at",
  "lastRunTs",
  "last_run_ts",
  "lastBuy",
  "last_buy",
  "interval",
  "intervalSec",
  "interval_sec",
  "owner",
  "phase",
  "mode",
  "reason",
] as const;

/** Drop URLs and key/token query fragments. Keeper errors can echo an RPC URL. */
function publicErrorText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const stripped = value
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/(?:api-key|token|key)=[^\s&#]*/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return stripped.length > 0 ? stripped : undefined;
}

function pickPublicPrefs(raw: unknown): KeeperPrefsPayload | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const prefs: KeeperPrefsPayload = {};
  if (Array.isArray(src.exclusions)) {
    prefs.exclusions = src.exclusions.filter(
      (item): item is string => typeof item === "string",
    );
  }
  for (const key of [
    "deadlines_unimportant",
    "premiums_matter",
    "premiums_especially_near_ipo",
    "buy_despite_ipo",
  ] as const) {
    if (typeof src[key] === "boolean") prefs[key] = src[key];
  }
  return prefs;
}

/**
 * Copy only the public status fields. A Jev key, RPC URL, port, session
 * token, or other extra field from a careless payload never lands in state.
 */
function pickPublicStatus(data: KeeperRunResult): KeeperRunResult {
  const src = data as KeeperRunResult & Record<string, unknown>;
  const out: KeeperRunResult = {
    ok: data.ok !== false,
    source:
      typeof data.source === "string" && data.source.trim() ? data.source : "daemon",
  };
  for (const key of ["skipped", "enabled", "daemon", "pending"] as const) {
    if (typeof src[key] === "boolean") out[key] = src[key];
  }
  if (typeof src.hasJevKey === "boolean") out.hasJevKey = src.hasJevKey;
  if (typeof src.amountUsd === "number" && Number.isFinite(src.amountUsd)) {
    out.amountUsd = src.amountUsd;
  }
  if (Array.isArray(src.names)) {
    out.names = src.names.filter((item): item is string => typeof item === "string");
  }
  for (const key of PUBLIC_TEXT_FIELDS) {
    const value = src[key];
    if (typeof value === "string" || typeof value === "number") {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  const error = publicErrorText(src.error);
  if (error) out.error = error;
  const detail = publicErrorText(src.detail);
  if (detail) out.detail = detail;
  const prefs = pickPublicPrefs(src.prefs);
  if (prefs) out.prefs = prefs;
  return out;
}

/**
 * Public keeper status for one wallet. No session, no signature, no auth headers.
 * Network errors and HTTP 5xx are keeper_unreachable (not Off).
 * HTTP 404 is public_status_unavailable (not Off).
 */
export async function keeperPublicStatus(owner: string): Promise<KeeperRunResult> {
  const key = owner.trim();
  if (!key) return { ok: false, error: "wallet_required" };
  const r = await keeperFetch(
    `/public/status?owner=${encodeURIComponent(key)}`,
    { method: "GET" },
    8000,
  );
  if (r.status === 404) {
    return { ok: false, error: "public_status_unavailable" };
  }
  if (r.timedOut || r.status === 0 || r.status >= 500 || !r.data) {
    return { ok: false, error: "keeper_unreachable" };
  }
  if (!r.ok) {
    return {
      ok: false,
      error:
        publicErrorText(r.data.error) ||
        publicErrorText(r.data.detail) ||
        `http_${r.status}`,
    };
  }
  return pickPublicStatus(r.data);
}

/**
 * Silent per-owner status. Same read as keeperPublicStatus.
 * Does not sign and does not mint a session.
 */
export async function keeperStatus(owner?: string): Promise<KeeperRunResult> {
  purgeStoredKeeperSessions();
  if (!owner?.trim()) return { ok: false, error: "wallet_required" };
  return keeperPublicStatus(owner.trim());
}

/** Push Settings prefs — one wallet signature (action:prefs). */
export async function keeperPushPrefs(
  prefs: KeeperPrefsPayload,
  owner?: string,
  signMessage?: KeeperSignFn,
): Promise<{ ok: boolean; prefs?: KeeperPrefsPayload; hasJevKey?: boolean; error?: string }> {
  if (!owner || !signMessage) {
    return { ok: false, error: "wallet_signature_required" };
  }
  let auth;
  try {
    auth = await signKeeperAuth(signMessage, "prefs", owner);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `sign_rejected: ${msg}` };
  }
  const r = await keeperFetch(
    "/prefs",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...auth, prefs, ...typesafeKeyJson() }),
    },
    15000,
  );
  if (!r.ok || !r.data) {
    const detail =
      (r.data && (r.data.error || r.data.detail)) ||
      (r.status === 0 ? "keeper_unreachable" : undefined);
    return {
      ok: false,
      error:
        detail ||
        (r.status === 401 || r.status === 403
          ? "signature_rejected"
          : `http_${r.status || 0}`),
    };
  }
  const refreshed = await withPublicRefresh(owner, { ...r.data, ok: true });
  return {
    ok: true,
    prefs: refreshed.prefs ?? r.data.prefs,
    hasJevKey: refreshed.hasJevKey,
  };
}

/** Prefs from the public status read. No signature. */
export async function keeperGetPrefs(
  owner?: string,
): Promise<{
  ok: boolean;
  prefs?: KeeperPrefsPayload;
  hasJevKey?: boolean;
  error?: string;
}> {
  if (!owner?.trim()) {
    return { ok: false, error: "wallet_required" };
  }
  const st = await keeperPublicStatus(owner);
  if (!st.ok) {
    return { ok: false, error: st.error };
  }
  return { ok: true, prefs: st.prefs, hasJevKey: st.hasJevKey };
}

export function getKeeperBaseUrl(): string {
  return keeperUrl();
}
