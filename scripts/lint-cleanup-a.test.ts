import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const nav = readFileSync(new URL("../components/Nav.tsx", import.meta.url), "utf8");
const runPrice = readFileSync(new URL("../lib/run-price.ts", import.meta.url), "utf8");
const weekly = readFileSync(new URL("../scripts/weekly-vault-buy.mjs", import.meta.url), "utf8");
const overview = readFileSync(new URL("../components/OverviewView.tsx", import.meta.url), "utf8");

test("LocaleBtn is defined at module scope, not inside Nav", () => {
  const declAt = nav.search(/^function LocaleBtn\(/m);
  const navAt = nav.indexOf("export function Nav(");
  assert.ok(declAt >= 0, "LocaleBtn must be a module-level function");
  assert.ok(navAt > declAt, "LocaleBtn must be declared before Nav");
  assert.equal(nav.slice(navAt).includes("function LocaleBtn"), false);
  assert.equal((nav.match(/<LocaleBtn code="pl" locale=\{locale\} setLocale=\{setLocale\} \/>/g) ?? []).length, 2);
  assert.equal((nav.match(/<LocaleBtn code="en" locale=\{locale\} setLocale=\{setLocale\} \/>/g) ?? []).length, 2);
  assert.equal((nav.match(/role="group"/g) ?? []).length, 2);
  assert.equal((nav.match(/aria-label="Language"/g) ?? []).length, 2);
  assert.match(nav, /aria-pressed=\{active\}/);
  assert.match(nav, /bg-\[#2dd4bf22\] text-\[#2dd4bf\] border border-\[#2dd4bf66\]/);
  assert.match(nav, /bg-\[#a78bfa22\] text-\[#a78bfa\] border border-\[#a78bfa66\]/);
  assert.match(nav, /border border-transparent text-\[#8b95a8\] hover:text-\[#e8eef5\]/);
  assert.match(nav, /useIsClient\(\)/);
  assert.doesNotMatch(nav, /setWalletReady/);
});

test("run-price does not import BN", () => {
  assert.doesNotMatch(runPrice, /@coral-xyz\/anchor/);
  assert.doesNotMatch(runPrice, /\bBN\b/);
});

test("weekly-vault-buy drops the unused crankIdl helper and the no-new disable", () => {
  assert.doesNotMatch(weekly, /eslint-disable/);
  assert.doesNotMatch(weekly, /\bcrankIdl\b/);
  const fn = weekly.slice(weekly.indexOf("function assertOwnerPubkey"), weekly.indexOf("function ownerDir"));
  assert.match(fn, /new PublicKey\(s\)/);
  assert.match(fn, /catch \{\s*throw new Error\(`invalid owner pubkey: \$\{s\}`\)/);
  assert.doesNotMatch(fn, /catch\s*\(/);
});

test("buy preview effect depends on the stable previewBuy callback", () => {
  const start = overview.indexOf("const previewBuy = predca.previewBuy;");
  assert.ok(start >= 0);
  const effect = overview.slice(start, overview.indexOf("const top3Title", start));
  assert.match(effect, /void previewBuy\(names\)/);
  assert.doesNotMatch(effect, /predca\.previewBuy\(/);
  assert.match(
    effect,
    /\}, \[connected, onChainReady, top3Names, previewBuy, locale, t\]\);/,
  );
  assert.match(effect, /shownBuyPreview = previewGateOpen \? buyPreview : null/);
});
