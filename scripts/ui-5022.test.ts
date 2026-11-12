import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { APP_VERSION } from "../lib/app-version";
import { effectiveExclusions, userExclusions } from "../lib/exclusions";
import { translate } from "../lib/i18n";

const settingsSrc = readFileSync(
  new URL("../components/SettingsView.tsx", import.meta.url),
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

const ACCOUNT_LABEL = "text-[11px] uppercase tracking-[0.15em] text-[#2dd4bf]";

test("settings is one column at max-w-xl on every width", () => {
  assert.match(settingsSrc, /mx-auto max-w-xl space-y-5/);
  assert.doesNotMatch(settingsSrc, /max-w-6xl/);
  assert.doesNotMatch(settingsSrc, /lg:grid-cols-2/);
  assert.match(overviewSrc, /grid gap-4 lg:grid-cols-2/);

  const root = settingsSrc.indexOf('className="mx-auto max-w-xl space-y-5"');
  const notice = settingsSrc.indexOf("predca.sessionCheckMsg");
  const unresolved = settingsSrc.indexOf("predca.visibleUnresolvedTxs");
  const exclusions = settingsSrc.indexOf('t("settings.exclusions")');
  const filters = settingsSrc.indexOf('t("settings.purchaseFilters")');
  const sign = settingsSrc.indexOf("void signAndSavePrefs()");
  const weekly = settingsSrc.indexOf('t("settings.weeklyAmount")');
  const saveBudget = settingsSrc.indexOf("void saveWeeklyBudgetOnChain()");
  const auto = settingsSrc.indexOf('t("settings.autoWeekly")');
  const mode = settingsSrc.indexOf("autoBuy.keeperMode");
  const byok = settingsSrc.indexOf('t("settings.byokTitle")');

  assert.ok(root > 0);
  assert.ok(notice > root && notice < exclusions);
  assert.ok(unresolved > root && unresolved < exclusions);
  assert.ok(exclusions > unresolved);
  assert.ok(filters > exclusions);
  assert.ok(sign > filters && sign < weekly);
  assert.ok(weekly > filters);
  assert.ok(saveBudget > weekly && saveBudget < byok);
  assert.ok(auto > weekly && auto < byok);
  assert.ok(mode > weekly && mode < byok);
  assert.ok(byok > weekly);
});

test("purchase filters have the exclusions label style", () => {
  assert.deepEqual(values("settings.purchaseFilters"), [
    "Filtry zakupu",
    "Purchase filters",
  ]);
  assert.equal(translate("pl", "settings.purchaseFilters"), "Filtry zakupu");
  assert.equal(translate("en", "settings.purchaseFilters"), "Purchase filters");

  const label = ACCOUNT_LABEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(
    settingsSrc,
    new RegExp(`<span className="${label}">\\s*\\{t\\("settings\\.purchaseFilters"\\)\\}`),
  );
  assert.match(
    settingsSrc,
    new RegExp(`<span className="${label}">\\s*\\{t\\("settings\\.exclusions"\\)\\}`),
  );

  const filtersAt = settingsSrc.indexOf('t("settings.purchaseFilters")');
  const byokAt = settingsSrc.indexOf('t("settings.byokTitle")');
  const block = settingsSrc.slice(filtersAt, byokAt);
  assert.match(block, /t\("settings\.buyDespiteIpo"\)/);
  assert.match(block, /t\("settings\.deadlineInvalid"\)/);
  assert.match(block, /t\("settings\.deadlineInvalidHint"\)/);
  assert.match(block, /t\("settings\.ipoPremium"\)/);
  assert.match(block, /void signAndSavePrefs\(\)/);
});

test("the xAI exclusion sentence is gone and xAI stays excluded", () => {
  assert.doesNotMatch(settingsSrc, /fixedExclusion/);
  assert.doesNotMatch(i18nSrc, /fixedExclusion/);
  assert.doesNotMatch(i18nSrc, /zawsze wykluczony/);
  assert.doesNotMatch(i18nSrc, /always excluded/);
  assert.equal(values("settings.fixedExclusion").length, 0);
  assert.equal(translate("pl", "settings.fixedExclusion"), "settings.fixedExclusion");
  assert.equal(translate("en", "settings.fixedExclusion"), "settings.fixedExclusion");
  assert.deepEqual(effectiveExclusions(""), ["xAI"]);
  assert.deepEqual(effectiveExclusions("OpenAI"), ["xAI", "OpenAI"]);
  assert.deepEqual(userExclusions("xAI, OpenAI, xai"), ["OpenAI"]);
  assert.match(settingsSrc, /userExclusions\(/);
});

test("v5.0.25 stays on the profit/loss section", () => {
  assert.equal(APP_VERSION, "5.0.25");
  const pnl = overviewSrc.slice(
    overviewSrc.indexOf("function PnlSection"),
    overviewSrc.indexOf("function PositionsCard"),
  );
  assert.match(pnl, /v\{APP_VERSION\}/);
  assert.match(pnl, /title=\{`v\$\{APP_VERSION\}`\}/);
  assert.match(pnl, /t\("pnl\.title"\)/);
});
