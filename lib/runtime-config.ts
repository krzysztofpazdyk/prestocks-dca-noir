/**
 * Public runtime addresses from `config.json` (same origin, under basePath).
 * Empty fields fall back to build-time NEXT_PUBLIC_* values.
 * Never put keys, tokens, or keyed RPC URLs in that file.
 */

import { acceptPublicUrl } from "./public-url.mjs";

export { acceptPublicUrl };

export type RuntimeConfig = {
  dcaApiUrl: string;
  keeperUrl: string;
};

export const RUNTIME_CONFIG_TIMEOUT_MS = 5000;

const EMPTY: RuntimeConfig = { dcaApiUrl: "", keeperUrl: "" };

let generation = 0;
let pending: Promise<RuntimeConfig> | null = null;
let cached: RuntimeConfig = { dcaApiUrl: "", keeperUrl: "" };
let ready = false;
let warned = false;
const listeners = new Set<() => void>();

export function subscribeRuntimeConfig(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

export function runtimeConfigReady(): boolean {
  return ready;
}

/** Server render has no config yet. The client gate loads it after hydration. */
export function runtimeConfigServerReady(): boolean {
  return false;
}

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* a subscriber must not break config loading */
    }
  }
}

function publish(next: RuntimeConfig, gen: number): RuntimeConfig {
  if (gen !== generation) return next;
  cached = next;
  ready = true;
  notify();
  return cached;
}

/** Open the UI gate even if the fetch never settled. Does not invent a URL. */
export function settleRuntimeConfig(): void {
  if (ready) return;
  ready = true;
  notify();
}

/** Test isolation. Page loads keep one promise for the lifetime of the module. */
export function resetRuntimeConfigForTests(): void {
  generation += 1;
  pending = null;
  cached = { dcaApiUrl: "", keeperUrl: "" };
  ready = false;
  warned = false;
}

function warnConfig(): void {
  if (warned) return;
  warned = true;
  console.warn("config.json: nieudane wczytanie, fallback do adresu z buildu");
}

export function appBasePath(): string {
  return (process.env.NEXT_PUBLIC_BASE_PATH || "/prestocks-dca-noir").replace(
    /\/$/,
    "",
  );
}

export function runtimeConfigRequestUrl(now = Date.now()): string {
  return `${appBasePath()}/config.json?t=${now}`;
}

export function parseRuntimeConfig(raw: unknown): RuntimeConfig {
  if (raw === null || typeof raw !== "object") return { ...EMPTY };
  const record = raw as Record<string, unknown>;
  return {
    dcaApiUrl: acceptPublicUrl(record.dcaApiUrl),
    keeperUrl: acceptPublicUrl(record.keeperUrl),
  };
}

export function runtimeDcaApiUrl(): string {
  return cached.dcaApiUrl;
}

export function runtimeKeeperUrl(): string {
  return cached.keeperUrl;
}

async function readConfig(
  fetchImpl: typeof fetch,
  timeoutMs: number,
  now: number,
  gen: number,
): Promise<RuntimeConfig> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fetchPromise = Promise.resolve().then(() =>
    // Default `fetch` is the window method. Calling the extracted function
    // without `this` throws "Illegal invocation" in the browser.
    Reflect.apply(fetchImpl, globalThis, [
      runtimeConfigRequestUrl(now),
      {
        cache: "no-store",
        signal: ctrl.signal,
      },
    ]) as Promise<Response>,
  );
  void fetchPromise.catch(() => {
    /* abort after a timeout must not become an unhandled rejection */
  });
  const timeoutPromise = new Promise<Response>((_resolve, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new Error("config-timeout"));
    }, timeoutMs);
  });
  void timeoutPromise.catch(() => {
    /* handled by the race when the timer wins; ignored when fetch wins */
  });

  const finish = (next: RuntimeConfig): RuntimeConfig => {
    if (timer !== undefined) clearTimeout(timer);
    return publish(next, gen);
  };

  try {
    const resp = await Promise.race([fetchPromise, timeoutPromise]);
    if (!resp || resp.ok !== true) {
      warnConfig();
      return finish({ ...EMPTY });
    }
    try {
      const raw: unknown = await resp.json();
      return finish(parseRuntimeConfig(raw));
    } catch {
      warnConfig();
      return finish({ ...EMPTY });
    }
  } catch {
    warnConfig();
    return finish({ ...EMPTY });
  }
}

export function loadRuntimeConfig(
  fetchImpl: typeof fetch = fetch,
  options?: { timeoutMs?: number; now?: number },
): Promise<RuntimeConfig> {
  if (pending) return pending;
  const gen = generation;
  const timeoutMs = options?.timeoutMs ?? RUNTIME_CONFIG_TIMEOUT_MS;
  const now = options?.now ?? Date.now();
  pending = readConfig(fetchImpl, timeoutMs, now, gen).then(
    (cfg) => cfg,
    () => {
      warnConfig();
      return publish({ ...EMPTY }, gen);
    },
  );
  return pending;
}

export function ensureRuntimeConfig(): Promise<RuntimeConfig> {
  return loadRuntimeConfig();
}
