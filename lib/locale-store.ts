export type Locale = "pl" | "en";

export const LOCALE_STORAGE_KEY = "noir3.predca_locale";
export const DEFAULT_LOCALE: Locale = "pl";

const listeners = new Set<() => void>();

function browserLocalStorage(): Storage | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
    if (typeof globalThis.localStorage !== "undefined") {
      return globalThis.localStorage;
    }
  } catch {
    /* private mode or a thrown getter */
  }
  return null;
}

/** Stored locale, or the default when the key is missing or not pl/en. */
export function readStoredLocale(): Locale {
  try {
    const storage = browserLocalStorage();
    if (!storage) return DEFAULT_LOCALE;
    const v = storage.getItem(LOCALE_STORAGE_KEY);
    if (v === "pl" || v === "en") return v;
  } catch {
    /* ignore */
  }
  return DEFAULT_LOCALE;
}

export function getLocaleSnapshot(): Locale {
  return readStoredLocale();
}

export function getLocaleServerSnapshot(): Locale {
  return DEFAULT_LOCALE;
}

export function emitLocaleChange(): void {
  for (const listener of listeners) listener();
}

/**
 * Same-tab updates come from `emitLocaleChange` (storage events do not fire
 * in the tab that wrote the key). Other tabs notify through `storage`.
 */
export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key != null && event.key !== LOCALE_STORAGE_KEY) return;
    listener();
  };
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("storage", onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener("storage", onStorage);
    }
  };
}

/** Write the same key the provider has always used, then notify subscribers. */
export function writeStoredLocale(next: Locale): void {
  try {
    const storage = browserLocalStorage();
    storage?.setItem(LOCALE_STORAGE_KEY, next);
  } catch {
    /* ignore */
  }
  emitLocaleChange();
}
