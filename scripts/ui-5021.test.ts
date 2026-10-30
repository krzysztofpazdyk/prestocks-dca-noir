import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { APP_VERSION } from "../lib/app-version";
import { translate } from "../lib/i18n";

const settingsSrc = readFileSync(
  new URL("../components/SettingsView.tsx", import.meta.url),
  "utf8",
);
const historySrc = readFileSync(
  new URL("../components/HistoryView.tsx", import.meta.url),
  "utf8",
);
const historyLib = readFileSync(
  new URL("../lib/history-view.ts", import.meta.url),
  "utf8",
);
const overviewSrc = readFileSync(
  new URL("../components/OverviewView.tsx", import.meta.url),
  "utf8",
);
const i18nSrc = readFileSync(new URL("../lib/i18n.tsx", import.meta.url), "utf8");

function values(key: string): string[] {
  const re = new RegExp(`"${key.replace(/\./g, "\\.")}":\\s*"([^"]*)"`, "g");
  return [...i18nSrc.matchAll(re)].map((hit) => hit[1]);
}

function buttonClassAfter(src: string, marker: string): string {
  const at = src.indexOf(marker);
  assert.ok(at > 0, marker);
  const match = src.slice(at, at + 500).match(/className="([^"]+)"/);
  assert.ok(match, marker);
  return match[1];
}

const ACCOUNT_LABEL = "text-[11px] uppercase tracking-[0.15em] text-[#2dd4bf]";

test("settings drops the DCA configuration heading and the gap above the form", () => {
  assert.equal(values("settings.kicker").length, 0);
  assert.equal(translate("pl", "settings.kicker"), "settings.kicker");
  assert.equal(translate("en", "settings.kicker"), "settings.kicker");
  assert.doesNotMatch(settingsSrc, /settings\.kicker/);
  assert.doesNotMatch(settingsSrc, /<h1/);
  assert.doesNotMatch(settingsSrc, /Konfiguracja DCA|DCA configuration/);
  assert.match(
    settingsSrc,
    /mx-auto max-w-xl space-y-5">\s*\{predca\.sessionCheckMsg \? \(/,
  );
});

test("exclusions label is only the word, in the DCA account color", () => {
  assert.deepEqual(values("settings.exclusions"), ["Wykluczenia", "Exclusions"]);
  assert.equal(translate("pl", "settings.exclusions"), "Wykluczenia");
  assert.equal(translate("en", "settings.exclusions"), "Exclusions");
  assert.doesNotMatch(values("settings.exclusions").join("\n"), /OpenAI|Kalshi|xAI|ranking/);
  const label = ACCOUNT_LABEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(
    overviewSrc,
    new RegExp(`<h2 className="${label}">\\s*\\{t\\("predca\\.title"\\)\\}`),
  );
  assert.match(
    settingsSrc,
    new RegExp(`<span className="${label}">\\s*\\{t\\("settings\\.exclusions"\\)\\}`),
  );
  assert.match(settingsSrc, /\{t\("settings\.fixedExclusion"\)\}/);
  assert.match(settingsSrc, /placeholder="OpenAI, Kalshi"/);
  assert.match(values("settings.fixedExclusion")[0], /xAI/);
  assert.match(values("settings.fixedExclusion")[1], /xAI/);
});

test("on-chain budget uses the sign-and-save colors and both buttons are full width", () => {
  const sign = buttonClassAfter(settingsSrc, "void signAndSavePrefs()");
  const budget = buttonClassAfter(settingsSrc, "void saveWeeklyBudgetOnChain()");
  const shared = [
    "w-full",
    "border-[#fbbf2466]",
    "bg-[#0c0e12]",
    "text-[#fbbf24]",
    "hover:bg-[#fbbf2411]",
    "uppercase",
    "tracking-wider",
  ];
  for (const token of shared) {
    assert.equal(sign.includes(token), true, `sign ${token}`);
    assert.equal(budget.includes(token), true, `budget ${token}`);
  }
  assert.equal(sign.includes("disabled:cursor-not-allowed"), true);
  assert.equal(sign.includes("disabled:opacity-50"), true);
  assert.equal(budget.includes("disabled:opacity-40"), true);
  assert.equal(budget.includes("text-[#2dd4bf]"), false);
  assert.equal(budget.includes("border-[#2dd4bf44]"), false);
  assert.match(settingsSrc, /disabled=\{prefsSaving \|\| !canSign\}/);
  assert.match(
    settingsSrc,
    /disabled=\{chainBusy \|\| predca\.status === "error" \|\| !weeklyParsed\.ok\}/,
  );
  assert.equal(translate("pl", "settings.prefsSignSave"), "Podpisz i zapisz");
  assert.equal(translate("en", "settings.prefsSignSave"), "Sign & save");
  assert.equal(translate("pl", "settings.prefsSignSaving"), "Podpisywanie…");
  assert.equal(translate("en", "settings.prefsSignSaving"), "Signing…");
  assert.equal(translate("pl", "settings.saveOnChain"), "Zapisz budżet on-chain");
  assert.equal(translate("en", "settings.saveOnChain"), "Save budget on-chain");
  assert.equal(translate("pl", "settings.savingOnChain"), "Zapis on-chain…");
  assert.equal(translate("en", "settings.savingOnChain"), "Saving on-chain…");
});

test("keeper mode and the next vault purchase share one line", () => {
  const start = settingsSrc.indexOf("autoBuy.keeperMode");
  const auto = settingsSrc.slice(start, settingsSrc.indexOf("autoBuy.message", start));
  assert.equal(auto.split("<p").length - 1, 1);
  assert.match(auto, /<span className="text-\[#8b95a8\]"> · <\/span>/);
  assert.match(auto, /t\("settings\.keeperModeLive"\)/);
  assert.match(auto, /t\("settings\.keeperModeDryRun"\)/);
  assert.match(auto, /t\("auto\.status\.next", \{ when: autoBuy\.nextLabel \}\)/);
  assert.match(auto, /\{autoBuy\.keeperMode \? \(/);
  assert.match(auto, /autoBuy\.keeperMode && autoBuy\.nextLabel && autoBuy\.enabled/);
  assert.match(auto, /autoBuy\.nextLabel && autoBuy\.enabled \? \(/);
  assert.equal(translate("pl", "settings.keeperModeLive"), "Tryb: Live (prawdziwe zakupy)");
  assert.equal(translate("en", "settings.keeperModeLive"), "Mode: Live (real buys)");
  assert.equal(
    translate("pl", "auto.status.next", { when: "WHEN" }),
    "Następny automatyczny zakup z vaulta: WHEN",
  );
  assert.equal(
    translate("en", "auto.status.next", { when: "WHEN" }),
    "Next automatic vault purchase: WHEN",
  );

  const whenPl = "30 paź 2026, 11:00";
  const whenEn = "30 Oct 2026, 11:00";
  const lines = [
    `${translate("pl", "settings.keeperModeLive")} · ${translate("pl", "auto.status.next", { when: whenPl })}`,
    `${translate("pl", "settings.keeperModeDryRun")} · ${translate("pl", "auto.status.next", { when: whenPl })}`,
    `${translate("en", "settings.keeperModeLive")} · ${translate("en", "auto.status.next", { when: whenEn })}`,
    `${translate("en", "settings.keeperModeDryRun")} · ${translate("en", "auto.status.next", { when: whenEn })}`,
  ];
  // max-w-xl card, p-5, 1px border. 10px sans measured under ~5.2px per character.
  const innerPx = 36 * 16 - 40 - 2;
  for (const line of lines) {
    assert.ok(line.length * 5.2 < innerPx, `${line.length} chars ${line}`);
  }
});

test("history no longer shows the entry count", () => {
  for (const key of ["history.entries.one", "history.entries.few", "history.entries.many"]) {
    assert.equal(values(key).length, 0, key);
    assert.equal(translate("pl", key, { count: 4 }), key);
    assert.equal(translate("en", key, { count: 4 }), key);
  }
  assert.doesNotMatch(historySrc, /historyEntriesLine|historyEntryForm|<h1/);
  assert.doesNotMatch(historyLib, /historyEntriesLine|historyEntryForm|history\.entries/);
  assert.match(historySrc, /intro != null \? \(/);
  assert.match(historySrc, /<p className="text-xs text-\[#8b95a8\]">\{intro\}<\/p>/);
  assert.match(historySrc, /t\("history\.loading"\)/);
  assert.match(historySrc, /t\("history\.noRuns"\)/);
  assert.match(historySrc, /t\("history\.notReady"\)/);
  assert.match(historySrc, /t\("history\.fetchError"\)/);
  assert.match(historySrc, /disconnectedCopy/);
  assert.match(historySrc, /mode === "list_stale"/);
  assert.match(values("history.loading")[0], /^Ładowanie historii on-chain/);
  assert.match(values("history.loading")[1], /^Loading on-chain history/);
  assert.match(values("history.fetchError")[0], /Nie udało się pobrać historii/);
  assert.match(values("history.fetchError")[1], /Couldn't load history/);
  assert.match(values("history.noRuns")[0], /Brak RunRecord on-chain/);
  assert.match(values("history.noRuns")[1], /No on-chain RunRecord/);
});

test("v5.0.21 stays on the profit/loss section", () => {
  assert.equal(APP_VERSION, "5.0.21");
  const pnl = overviewSrc.slice(
    overviewSrc.indexOf("function PnlSection"),
    overviewSrc.indexOf("function PositionsCard"),
  );
  assert.match(pnl, /v\{APP_VERSION\}/);
  assert.match(pnl, /title=\{`v\$\{APP_VERSION\}`\}/);
  assert.match(pnl, /t\("pnl\.title"\)/);
});
