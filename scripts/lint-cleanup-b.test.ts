import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DEFAULT_SETTINGS } from "../lib/mock-data";
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  emitLocaleChange,
  getLocaleServerSnapshot,
  getLocaleSnapshot,
  readStoredLocale,
  subscribeLocale,
  writeStoredLocale,
} from "../lib/locale-store";
import { settingsWeeklyFromStorage } from "../lib/settings-weekly";
import { writeWeeklyDraft } from "../lib/weekly-budget";
import { writeWeeklyBudgetUsd, scopedLsKey, LS_WEEKLY_BUDGET } from "../lib/auto-weekly-buy";

const nav = readFileSync(new URL("../components/Nav.tsx", import.meta.url), "utf8");
const connect = readFileSync(
  new URL("../components/ConnectWalletButton.tsx", import.meta.url),
  "utf8",
);
const clientHook = readFileSync(
  new URL("../lib/hooks/useIsClient.ts", import.meta.url),
  "utf8",
);
const i18n = readFileSync(new URL("../lib/i18n.tsx", import.meta.url), "utf8");
const overview = readFileSync(
  new URL("../components/OverviewView.tsx", import.meta.url),
  "utf8",
);
const settings = readFileSync(
  new URL("../components/SettingsView.tsx", import.meta.url),
  "utf8",
);
const predcaHook = readFileSync(
  new URL("../lib/hooks/usePredca.ts", import.meta.url),
  "utf8",
);

function installLocalStorage(): { restore: () => void } {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => (data.has(key) ? data.get(key)! : null),
    setItem: (key: string, value: string) => {
      data.set(key, String(value));
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    clear: () => data.clear(),
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  } as Storage;
  const prev = globalThis.localStorage;
  globalThis.localStorage = storage;
  return {
    restore() {
      if (prev === undefined) {
        delete (globalThis as { localStorage?: Storage }).localStorage;
      } else {
        globalThis.localStorage = prev;
      }
    },
  };
}

test("mount flags use the client snapshot instead of setState in an effect", () => {
  assert.match(clientHook, /useSyncExternalStore/);
  assert.match(clientHook, /return false/);
  assert.match(clientHook, /return true/);
  assert.match(nav, /const walletReady = useIsClient\(\)/);
  assert.doesNotMatch(nav, /setWalletReady/);
  assert.doesNotMatch(nav, /useEffect/);
  assert.match(connect, /const mounted = useIsClient\(\)/);
  assert.doesNotMatch(connect, /setMounted/);
  const connectFn = connect.slice(
    connect.indexOf("export function ConnectWalletButton"),
    connect.indexOf("function AdapterConnect"),
  );
  assert.doesNotMatch(connectFn, /useEffect\(/);
  assert.doesNotMatch(connectFn, /setState/);
});

test("locale store reads storage, defaults, and notifies on write", () => {
  assert.equal(getLocaleServerSnapshot(), DEFAULT_LOCALE);
  const storage = installLocalStorage();
  const seen: string[] = [];
  const stop = subscribeLocale(() => {
    seen.push(readStoredLocale());
  });
  try {
    assert.equal(readStoredLocale(), "pl");
    assert.equal(getLocaleSnapshot(), "pl");
    localStorage.setItem(LOCALE_STORAGE_KEY, "nope");
    assert.equal(readStoredLocale(), "pl");
    localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    assert.equal(getLocaleSnapshot(), "en");
    writeStoredLocale("pl");
    assert.equal(localStorage.getItem(LOCALE_STORAGE_KEY), "pl");
    assert.deepEqual(seen, ["pl"]);
    emitLocaleChange();
    assert.deepEqual(seen, ["pl", "pl"]);
  } finally {
    stop();
    storage.restore();
  }
});

test("i18n provider subscribes to the locale store and still sets document lang", () => {
  assert.match(i18n, /useSyncExternalStore\(\s*subscribeLocale/);
  assert.match(i18n, /getLocaleServerSnapshot/);
  assert.doesNotMatch(i18n, /setLocaleState/);
  assert.match(i18n, /writeStoredLocale\(next\)/);
  assert.match(i18n, /document\.documentElement\.lang = next/);
  assert.match(i18n, /document\.documentElement\.lang = locale/);
  assert.match(i18n, /export function useI18n/);
  assert.match(i18n, /export function I18nProvider/);
});

test("settings weekly amount comes from storage without setState in the load effect", () => {
  const owner = "Owner1111111111111111111111111111111111";
  const storage = installLocalStorage();
  const prevSession = globalThis.sessionStorage;
  const session = new Map<string, string>();
  globalThis.sessionStorage = {
    getItem: (key: string) => (session.has(key) ? session.get(key)! : null),
    setItem: (key: string, value: string) => {
      session.set(key, String(value));
    },
    removeItem: (key: string) => {
      session.delete(key);
    },
    clear: () => session.clear(),
    key: (index: number) => [...session.keys()][index] ?? null,
    get length() {
      return session.size;
    },
  } as Storage;
  try {
    assert.deepEqual(settingsWeeklyFromStorage(null), {
      amount: DEFAULT_SETTINGS.weeklyAmountUsd,
      draft: String(DEFAULT_SETTINGS.weeklyAmountUsd),
    });
    writeWeeklyDraft(80);
    assert.equal(settingsWeeklyFromStorage(null).amount, 80);
    assert.equal(settingsWeeklyFromStorage(owner).amount, 80);
    writeWeeklyBudgetUsd(200, owner);
    assert.equal(settingsWeeklyFromStorage(owner).amount, 200);
    session.clear();
    localStorage.setItem(scopedLsKey(LS_WEEKLY_BUDGET, owner), "nope");
    assert.equal(
      settingsWeeklyFromStorage(owner).amount,
      DEFAULT_SETTINGS.weeklyAmountUsd,
    );
  } finally {
    storage.restore();
    if (prevSession === undefined) {
      delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
    } else {
      globalThis.sessionStorage = prevSession;
    }
  }

  assert.match(settings, /settingsWeeklyFromStorage\(ownerBase58\)/);
  assert.match(settings, /adoptWeeklyDraftForOwner\(ownerBase58\)/);
  assert.match(settings, /const prefsReady = hydratedOwner === ownerKey/);
  assert.doesNotMatch(settings, /setPrefsReady\(/);
  assert.doesNotMatch(settings, /setWeeklyReady\(/);
  const load = settings.slice(
    settings.indexOf("adoptWeeklyDraftForOwner(ownerBase58)"),
    settings.indexOf("const companySnap"),
  );
  assert.doesNotMatch(load, /setWeekly\(/);
});

test("buy preview hides when the gate is closed and the mount refresh is deferred", () => {
  assert.match(overview, /const shownBuyPreview = previewGateOpen \? buyPreview : null/);
  assert.match(overview, /\{shownBuyPreview &&/);
  const effect = overview.slice(
    overview.indexOf("const previewBuy = predca.previewBuy;"),
    overview.indexOf("const top3Title"),
  );
  assert.doesNotMatch(
    effect,
    /if \(!connected \|\| !onChainReady \|\| names\.length < 3\) \{\s*setBuyPreview\(null\);/,
  );
  const mount = predcaHook.slice(predcaHook.indexOf("let cancelled = false;"));
  assert.match(mount, /queueMicrotask\(\(\) => \{\s*if \(cancelled\) return;\s*void refresh\(\);/);
});
