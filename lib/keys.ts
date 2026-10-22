/**
 * localStorage BYOK. Never commit a TypeSafe secret.
 * The public playground may seed `NEXT_PUBLIC_TYPESAFE_DEFAULT_KEY` into
 * localStorage when that key was never written. Next inlines `NEXT_PUBLIC_*`
 * into the client bundle, so the demo value is extractable from Pages JS.
 * A saved empty string is an explicit clear and is not overwritten.
 */

import { runtimeDcaApiUrl } from "@/lib/runtime-config";

export const LS_TYPESAFE = "noir3.prestocks.TYPESAFE_API_KEY";
export const LS_XAI = "noir3.prestocks.XAI_API_KEY";
export const SS_PRODUCTS = "noir3.prestocks.session.products";
export const SS_RANK = "noir3.prestocks.session.rank";

type BrowserStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

/** SSR has no `window`. `globalThis` keeps the same check testable. */
function browserLocalStorage(): BrowserStorage | null {
  const g = globalThis as typeof globalThis & {
    window?: unknown;
    localStorage?: BrowserStorage;
  };
  if (typeof g.window === "undefined") return null;
  const storage = g.localStorage;
  if (
    !storage ||
    typeof storage.getItem !== "function" ||
    typeof storage.setItem !== "function"
  ) {
    return null;
  }
  return storage;
}

/**
 * First visit only: copy the build-time demo key into localStorage.
 * `null` means never written. `""` (clear + save) stays empty.
 */
export function ensureDefaultTypesafeKey(): void {
  const storage = browserLocalStorage();
  if (!storage) return;
  let existing: string | null;
  try {
    existing = storage.getItem(LS_TYPESAFE);
  } catch {
    return;
  }
  if (existing !== null) return;
  const seeded = (process.env.NEXT_PUBLIC_TYPESAFE_DEFAULT_KEY ?? "").trim();
  if (!seeded) return;
  try {
    storage.setItem(LS_TYPESAFE, seeded);
  } catch {
    /* private mode / quota — leave the field empty */
  }
}

export function readTypesafeKey(): string {
  ensureDefaultTypesafeKey();
  const storage = browserLocalStorage();
  if (!storage) return "";
  try {
    return (storage.getItem(LS_TYPESAFE) ?? "").trim();
  } catch {
    return "";
  }
}

export function readXaiKey(): string {
  try {
    return (localStorage.getItem(LS_XAI) ?? "").trim();
  } catch {
    return "";
  }
}

export function hasByokTypesafe(): boolean {
  return readTypesafeKey().length > 0;
}

export function hasByokXai(): boolean {
  return readXaiKey().length > 0;
}

/**
 * Hosted DCA API base (no trailing slash).
 * Runtime `config.json` wins over `NEXT_PUBLIC_DCA_API_URL`. Empty = no API calls.
 */
export function dcaApiBase(): string {
  const runtime = runtimeDcaApiUrl().trim().replace(/\/$/, "");
  if (runtime) return runtime;
  return (process.env.NEXT_PUBLIC_DCA_API_URL ?? "").trim().replace(/\/$/, "");
}

/** Same-origin `/api/jev` exists only under `next dev`, not GitHub Pages. */
export function canUseSameOriginJevProxy(): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  return host === "localhost" || host === "127.0.0.1";
}
