import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { APP_VERSION } from "../lib/app-version";
import { DEFAULT_SETTINGS } from "../lib/mock-data";
import {
  LS_IPO_PREMIUM,
  rankPrefsForApi,
  readIpoPremiumMatters,
  readRankPrefs,
} from "../lib/rank-prefs";

type MemStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  clear: () => void;
  key: () => null;
  length: number;
};

function installStorage(): { data: Map<string, string>; restore: () => void } {
  const previousStorage = globalThis.localStorage;
  const previousWindow = globalThis.window;
  const data = new Map<string, string>();
  const storage: MemStorage = {
    getItem: (key) => (data.has(key) ? data.get(key)! : null),
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
    clear: () => data.clear(),
    key: () => null,
    length: 0,
  };
  globalThis.localStorage = storage as Storage;
  globalThis.window = globalThis as unknown as Window & typeof globalThis;
  return {
    data,
    restore() {
      if (previousStorage === undefined) {
        delete (globalThis as { localStorage?: Storage }).localStorage;
      } else {
        globalThis.localStorage = previousStorage;
      }
      if (previousWindow === undefined) {
        delete (globalThis as { window?: Window }).window;
      } else {
        globalThis.window = previousWindow;
      }
    },
  };
}

describe("IPO premium default", { concurrency: false }, () => {
  test("defaults on, and a saved choice still wins", () => {
    assert.equal(DEFAULT_SETTINGS.ipoPremiumMatters, true);
    assert.equal(APP_VERSION, "5.0.11");

    const mem = installStorage();
    try {
      assert.equal(readIpoPremiumMatters(), true);
      const prefs = readRankPrefs();
      assert.equal(prefs.ipoPremiumMatters, true);
      assert.equal(prefs.premiumsMatter, true);
      assert.equal(prefs.premiumsEspeciallyNearIpo, true);
      const body = rankPrefsForApi();
      assert.equal(body.premiums_matter, true);
      assert.equal(body.premiums_especially_near_ipo, true);

      mem.data.set(LS_IPO_PREMIUM, "false");
      assert.equal(readIpoPremiumMatters(), false);
      assert.equal(rankPrefsForApi().premiums_matter, false);
      assert.equal(rankPrefsForApi().premiums_especially_near_ipo, false);

      mem.data.set(LS_IPO_PREMIUM, "0");
      assert.equal(readIpoPremiumMatters(), false);
      assert.equal(rankPrefsForApi().premiums_matter, false);

      mem.data.set(LS_IPO_PREMIUM, "true");
      assert.equal(readIpoPremiumMatters(), true);
      assert.equal(rankPrefsForApi().premiums_matter, true);

      mem.data.set(LS_IPO_PREMIUM, "1");
      assert.equal(readIpoPremiumMatters(), true);
      assert.equal(rankPrefsForApi().premiums_matter, true);

      mem.data.set(LS_IPO_PREMIUM, "maybe");
      assert.equal(readIpoPremiumMatters(), true);
      assert.equal(rankPrefsForApi().premiums_matter, true);

      mem.data.delete(LS_IPO_PREMIUM);
      assert.equal(
        rankPrefsForApi({
          ...readRankPrefs(),
          premiumsMatter: false,
          premiumsEspeciallyNearIpo: false,
          ipoPremiumMatters: false,
        }).premiums_matter,
        false,
      );
    } finally {
      mem.restore();
    }
  });

  test("with no browser storage, ranking still treats the premium as on", () => {
    const previousStorage = globalThis.localStorage;
    const previousWindow = globalThis.window;
    delete (globalThis as { localStorage?: Storage }).localStorage;
    delete (globalThis as { window?: Window }).window;
    try {
      assert.equal(readIpoPremiumMatters(), true);
      assert.equal(rankPrefsForApi().premiums_matter, true);
    } finally {
      if (previousStorage === undefined) {
        delete (globalThis as { localStorage?: Storage }).localStorage;
      } else {
        globalThis.localStorage = previousStorage;
      }
      if (previousWindow === undefined) {
        delete (globalThis as { window?: Window }).window;
      } else {
        globalThis.window = previousWindow;
      }
    }
  });
});
