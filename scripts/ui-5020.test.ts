import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { APP_VERSION } from "../lib/app-version";
import { translate } from "../lib/i18n";

const overviewSrc = readFileSync(
  new URL("../components/OverviewView.tsx", import.meta.url),
  "utf8",
);
const settingsSrc = readFileSync(
  new URL("../components/SettingsView.tsx", import.meta.url),
  "utf8",
);
const historySrc = readFileSync(
  new URL("../components/HistoryView.tsx", import.meta.url),
  "utf8",
);

const HEADER_H1 =
  '<h1 className="text-xs uppercase tracking-[0.2em] text-[#a78bfa]">';

test("v5.0.20 stays on the profit/loss section", () => {
  assert.equal(APP_VERSION, "5.0.20");
  const pnlFn = overviewSrc.slice(
    overviewSrc.indexOf("function PnlSection"),
    overviewSrc.indexOf("function PositionsCard"),
  );
  assert.match(pnlFn, /v\{APP_VERSION\}/);
  assert.match(pnlFn, /title=\{`v\$\{APP_VERSION\}`\}/);
});

test("predca title is the DCA account label and neighbouring labels stay", () => {
  assert.equal(translate("pl", "predca.title"), "Twoje konto DCA");
  assert.equal(translate("en", "predca.title"), "Your DCA account");
  assert.match(overviewSrc, /\{t\("predca\.title"\)\}/);
  assert.equal(translate("pl", "predca.budget"), "Budżet tygodniowy");
  assert.equal(translate("en", "predca.budget"), "Weekly budget");
  assert.equal(translate("pl", "predca.vault"), "Vault");
  assert.equal(translate("en", "predca.vault"), "Vault");
  assert.equal(translate("pl", "settings.saveOnChain"), "Zapisz budżet on-chain");
  assert.equal(translate("en", "settings.saveOnChain"), "Save budget on-chain");
  assert.match(overviewSrc, /`chain \$\{formatUsd\(predca\.weeklyBudgetUsd\)\}`/);
});

test("Overview has no Trading desk kicker and no leading empty row", () => {
  assert.equal(translate("pl", "overview.kicker"), "overview.kicker");
  assert.equal(translate("en", "overview.kicker"), "overview.kicker");
  assert.doesNotMatch(overviewSrc, /overview\.kicker/);
  assert.doesNotMatch(overviewSrc, /Trading desk/);
  assert.doesNotMatch(overviewSrc, new RegExp(HEADER_H1.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(overviewSrc, /const overviewNotice = !connected/);
  assert.match(overviewSrc, /\{overviewNotice \? \(/);
  assert.match(overviewSrc, /t\("overview\.disconnectedHint"\)/);
  assert.match(overviewSrc, /t\("overview\.noMintHint"\)/);
});

test("settings intro under Konfiguracja DCA is gone", () => {
  assert.equal(translate("pl", "settings.intro"), "settings.intro");
  assert.equal(translate("en", "settings.intro"), "settings.intro");
  assert.equal(translate("pl", "settings.kicker"), "Konfiguracja DCA");
  assert.equal(translate("en", "settings.kicker"), "DCA configuration");
  assert.match(settingsSrc, /\{t\("settings\.kicker"\)\}/);
  assert.doesNotMatch(settingsSrc, /settings\.intro/);
  assert.doesNotMatch(settingsSrc, /BYOK zostaje w localStorage/);
  assert.doesNotMatch(settingsSrc, /BYOK stays in localStorage/);
});

test("history count uses the old kicker style and the kicker text is gone", () => {
  assert.equal(translate("pl", "history.kicker"), "history.kicker");
  assert.equal(translate("en", "history.kicker"), "history.kicker");
  assert.doesNotMatch(historySrc, /history\.kicker/);
  assert.doesNotMatch(historySrc, /Purchases \(auto & manual\)/);
  assert.equal(translate("pl", "history.entries.few", { count: 4 }), "4 wpisy");
  assert.equal(translate("en", "history.entries.many", { count: 4 }), "4 entries");
  assert.match(historySrc, /intro = historyEntriesLine\(predca\.runs\.length, locale\)/);
  assert.match(
    historySrc,
    /showRuns \? \([\s\S]*?<h1 className="text-xs uppercase tracking-\[0\.2em\] text-\[#a78bfa\]">\s*\{intro\}\s*<\/h1>[\s\S]*?<p className="text-xs text-\[#8b95a8\]">\{intro\}<\/p>/,
  );
  assert.doesNotMatch(
    historySrc,
    /<p className="text-xs text-\[#8b95a8\]">\{historyEntriesLine/,
  );
});

test("Top-3 sizes to its content for an empty list and for three rows", () => {
  assert.match(overviewSrc, /grid gap-4 lg:grid-cols-2 lg:items-stretch/);
  assert.match(
    overviewSrc,
    /<section className="rounded-lg border border-\[#1e2633\] bg-\[#141820\] p-5 lg:h-full">/,
  );
  assert.match(overviewSrc, /<div className="flex flex-col gap-4 lg:h-full">/);
  assert.doesNotMatch(overviewSrc, /flex min-h-0 flex-col gap-4/);

  const top3 = overviewSrc.slice(
    overviewSrc.indexOf('<section className="shrink-0 rounded-lg'),
    overviewSrc.indexOf("<PnlSection"),
  );
  assert.ok(top3.length > 0);
  assert.match(top3, /top3\.length === 0/);
  assert.match(top3, /top3\.map\(/);
  assert.doesNotMatch(top3, /flex-1/);
  assert.doesNotMatch(top3, /min-h-0/);

  const pnlFn = overviewSrc.slice(
    overviewSrc.indexOf("function PnlSection"),
    overviewSrc.indexOf("function PositionsCard"),
  );
  assert.match(
    pnlFn,
    /<section className="flex flex-1 flex-col rounded-lg border border-\[#1e2633\] bg-\[#141820\] p-5">/,
  );
  assert.doesNotMatch(pnlFn, /min-h-0/);
});
