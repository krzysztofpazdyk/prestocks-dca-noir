import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { APP_VERSION } from "../lib/app-version";
import { translate } from "../lib/i18n";

const navSrc = readFileSync(new URL("../components/Nav.tsx", import.meta.url), "utf8");
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

const KICKER_H1 =
  '<h1 className="text-xs uppercase tracking-[0.2em] text-[#a78bfa]">';

test("section kickers match tab label size and in-page tab titles are gone", () => {
  assert.match(navSrc, /text-xs tracking-wide uppercase/);

  assert.equal(overviewSrc.includes(KICKER_H1), false);
  assert.equal(settingsSrc.includes(KICKER_H1), true);
  assert.equal(historySrc.includes(KICKER_H1), true);
  assert.doesNotMatch(overviewSrc, /overview\.kicker/);
  assert.match(settingsSrc, /\{t\("settings\.kicker"\)\}/);
  assert.doesNotMatch(historySrc, /history\.kicker/);
  assert.match(historySrc, /historyEntriesLine\(predca\.runs\.length, locale\)/);

  assert.doesNotMatch(overviewSrc, /t\("overview\.title"\)/);
  assert.doesNotMatch(settingsSrc, /t\("settings\.title"\)/);
  assert.doesNotMatch(historySrc, /t\("history\.title"\)/);
  assert.doesNotMatch(overviewSrc, /text-xl font-semibold/);
  assert.doesNotMatch(settingsSrc, /text-xl font-semibold/);
  assert.doesNotMatch(historySrc, /text-xl font-semibold/);

  assert.equal(translate("pl", "overview.kicker"), "overview.kicker");
  assert.equal(translate("en", "overview.kicker"), "overview.kicker");
  assert.equal(translate("pl", "settings.kicker"), "Konfiguracja DCA");
  assert.equal(translate("en", "settings.kicker"), "DCA configuration");
  assert.equal(translate("pl", "history.kicker"), "history.kicker");
  assert.equal(translate("en", "history.kicker"), "history.kicker");
  assert.equal(translate("pl", "nav.overview"), "Overview");
  assert.equal(translate("pl", "nav.settings"), "Ustawienia");
  assert.equal(translate("pl", "nav.history"), "Historia");
  assert.equal(translate("en", "nav.overview"), "Overview");
  assert.equal(translate("en", "nav.settings"), "Settings");
  assert.equal(translate("en", "nav.history"), "History");
});

test("allocation / top3 / pnl column stretch fills the hole under Profit", () => {
  assert.match(overviewSrc, /grid gap-4 lg:grid-cols-2 lg:items-stretch/);
  assert.match(overviewSrc, /<div className="flex flex-col gap-4 lg:h-full">/);
  assert.doesNotMatch(overviewSrc, /flex min-h-0 flex-col gap-4 lg:h-full/);
  assert.match(
    overviewSrc,
    /<section className="shrink-0 rounded-lg border border-\[#1e2633\] bg-\[#141820\] p-5">/,
  );
  const pnlFn = overviewSrc.slice(
    overviewSrc.indexOf("function PnlSection"),
    overviewSrc.indexOf("function PositionsCard"),
  );
  assert.match(
    pnlFn,
    /<section className="flex flex-1 flex-col rounded-lg border border-\[#1e2633\] bg-\[#141820\] p-5">/,
  );
  assert.doesNotMatch(pnlFn, /min-h-0/);
  assert.match(pnlFn, /v\{APP_VERSION\}/);
  assert.equal(APP_VERSION, "5.0.20");
});
