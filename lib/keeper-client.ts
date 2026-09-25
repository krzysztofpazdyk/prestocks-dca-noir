/** Local keeper (bot fee-payer). Subsequent weekly buys — no wallet popup. */

const DEFAULT_KEEPER = "http://127.0.0.1:8791";

function keeperUrl(): string {
  const fromEnv = (process.env.NEXT_PUBLIC_KEEPER_URL ?? "").trim().replace(/\/$/, "");
  return fromEnv || DEFAULT_KEEPER;
}

export type KeeperRunResult = {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  signature?: string;
  names?: string[];
  amountUsd?: number;
  error?: string;
  nextAt?: string;
  enabled?: boolean;
  owner?: string;
  phase?: string;
  source?: "daemon" | "file" | string;
  daemon?: boolean;
};

function keeperAuthHeaders(): Record<string, string> {
  const token = (process.env.NEXT_PUBLIC_KEEPER_TOKEN ?? "").trim();
  return token ? { "X-Keeper-Token": token } : {};
}

async function keeperFetch(
  path: string,
  init?: RequestInit,
  timeoutMs = 90000,
): Promise<{ ok: boolean; status: number; data: KeeperRunResult | null }> {
  const ctrl = new AbortController();
  const t = window.setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${keeperUrl()}${path}`, {
      ...init,
      headers: {
        ...keeperAuthHeaders(),
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
    return { ok: resp.ok, status: resp.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  } finally {
    window.clearTimeout(t);
  }
}

export async function keeperHealth(): Promise<boolean> {
  const r = await keeperFetch("/health", { method: "GET" }, 3000);
  return r.ok;
}

export async function keeperRegister(owner: string): Promise<boolean> {
  const r = await keeperFetch(
    "/register",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner }),
    },
    8000,
  );
  return r.ok;
}

export async function keeperRun(force = false): Promise<KeeperRunResult> {
  const r = await keeperFetch(
    "/run",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force }),
    },
    120000,
  );
  if (!r.data) {
    return { ok: false, error: "keeper_unreachable" };
  }
  return r.data;
}

export async function keeperEnable(
  owner: string,
  force = true,
): Promise<KeeperRunResult> {
  const r = await keeperFetch(
    "/enable",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner, force }),
    },
    120000,
  );
  if (!r.data) {
    return { ok: false, error: "keeper_unreachable" };
  }
  return r.data;
}

export async function keeperDisable(): Promise<KeeperRunResult> {
  const r = await keeperFetch(
    "/disable",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
    8000,
  );
  if (!r.data) {
    return { ok: false, error: "keeper_unreachable" };
  }
  return r.data;
}

/**
 * Live keeper `/status` first; if daemon is down, Next `/api/keeper/status`
 * reads ~/.config/predca/enabled + owner.txt + status JSON so the Settings
 * toggle can still show ON for the matching wallet.
 */
export async function keeperStatus(): Promise<KeeperRunResult> {
  const r = await keeperFetch("/status", { method: "GET" }, 5000);
  if (r.data && r.status !== 0) {
    return { ...r.data, source: r.data.source ?? "daemon" };
  }
  try {
    const ctrl = new AbortController();
    const t = window.setTimeout(() => ctrl.abort(), 5000);
    const resp = await fetch("/api/keeper/status", {
      cache: "no-store",
      signal: ctrl.signal,
    });
    window.clearTimeout(t);
    if (resp.ok) {
      return (await resp.json()) as KeeperRunResult;
    }
  } catch {
    /* ignore */
  }
  return { ok: false, error: "keeper_unreachable" };
}

export type KeeperPrefsPayload = {
  exclusions?: string[];
  deadlines_unimportant?: boolean;
  premiums_matter?: boolean;
  premiums_especially_near_ipo?: boolean;
  buy_despite_ipo?: boolean;
};

/** Push Settings/localStorage rank prefs to keeper ~/.config/predca/prefs.json. */
export async function keeperPushPrefs(
  prefs: KeeperPrefsPayload,
): Promise<{ ok: boolean; prefs?: KeeperPrefsPayload; error?: string }> {
  const r = await keeperFetch(
    "/prefs",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(prefs),
    },
    8000,
  );
  if (!r.ok || !r.data) {
    return { ok: false, error: "keeper_unreachable" };
  }
  const data = r.data as KeeperRunResult & { prefs?: KeeperPrefsPayload };
  return { ok: true, prefs: data.prefs };
}

export async function keeperGetPrefs(): Promise<{
  ok: boolean;
  prefs?: KeeperPrefsPayload;
}> {
  const r = await keeperFetch("/prefs", { method: "GET" }, 5000);
  if (!r.ok || !r.data) return { ok: false };
  const data = r.data as KeeperRunResult & { prefs?: KeeperPrefsPayload };
  return { ok: true, prefs: data.prefs };
}

