import assert from "node:assert/strict";
import test from "node:test";
import { parseJupResponse, type JupQuote } from "../lib/jup-prices";
import {
  applyJupPremiums,
  buildProducts,
  summarizePremiumSource,
} from "../lib/prestocks";
import { HARDCODED_PREMIUMS_PCT, MINTS, REFERENCE_MINTS, XAI_MINT } from "../lib/universe";

const NOW = Date.parse("2026-10-10T12:00:00Z");

function quotes(usd: number, stock: number, updatedAt = NOW - 3_600_000): Record<string, JupQuote> {
  const raw: Record<string, unknown> = {};
  for (const mint of Object.values(MINTS)) {
    raw[mint] = {
      usdPrice: usd,
      liquidity: 80_000,
      stockData: { id: "prestocks", price: stock, updatedAt: new Date(updatedAt).toISOString() },
    };
  }
  return parseJupResponse(raw, NOW);
}

test("buildProducts prefers jupiter stock premium and ignores OURA and xAI", () => {
  const products = buildProducts(
    [
      { splMint: MINTS.Anthropic, tokenPrice: 90, marketCapUSD: 12 },
      { splMint: "oura-mint-not-in-universe", tokenPrice: 5, name: "OURA" },
      { splMint: XAI_MINT, tokenPrice: 9, name: "xAI" },
    ],
    quotes(80, 100),
    NOW,
  );
  assert.equal(products.length, 8);
  assert.equal(products.some((p) => p.name === "OURA" || p.name === "xAI" || p.mint === XAI_MINT), false);
  const anth = products.find((p) => p.name === "Anthropic");
  assert.ok(anth);
  assert.equal(anth.token_price_usd, 90);
  assert.equal(anth.mark_price_usd, 100);
  assert.equal(anth.premium_pct, -20);
  assert.equal(anth.premium_source, "jupiter_stockdata");
  assert.equal(summarizePremiumSource(products), "jupiter_stockdata");
  const spacex = products.find((p) => p.name === "SpaceX");
  assert.equal(spacex?.near_ipo, false);
});

test("token price falls back to usdPrice, and a dead premium uses the hardcoded estimate", () => {
  const fresh = buildProducts([], quotes(80, 100), NOW);
  const openai = fresh.find((p) => p.name === "OpenAI");
  assert.equal(openai?.token_price_usd, 80);
  assert.equal(openai?.premium_source, "jupiter_stockdata");

  const stale = buildProducts(
    [],
    quotes(80, 100, NOW - 73 * 60 * 60 * 1000),
    NOW,
  );
  const sx = stale.find((p) => p.name === "SpaceX");
  assert.ok(sx);
  assert.equal(sx.premium_source, "hardcoded_fallback");
  assert.equal(sx.premium_pct, HARDCODED_PREMIUMS_PCT.SpaceX);
  assert.equal(sx.mark_price_usd, null);
  assert.equal(sx.token_price_usd, 80);
  assert.equal(summarizePremiumSource(stale), "hardcoded_fallback (no live jupiter premium)");

  const wild = buildProducts([], quotes(200, 100), NOW);
  assert.equal(wild[0].premium_source, "hardcoded_fallback");
  assert.equal(wild[0].mark_price_usd, null);
});

test("applyJupPremiums overwrites premium only when the jupiter premium is usable", () => {
  const base = buildProducts([], quotes(80, 100, NOW - 73 * 60 * 60 * 1000), NOW);
  const kept = applyJupPremiums(base, quotes(80, 100, NOW - 73 * 60 * 60 * 1000), NOW);
  assert.equal(kept[0].premium_source, "hardcoded_fallback");

  const next = applyJupPremiums(base, quotes(90, 100), NOW);
  const row = next.find((p) => p.name === "Anthropic");
  assert.ok(row);
  assert.equal(row.premium_source, "jupiter_stockdata");
  assert.equal(row.mark_price_usd, 100);
  assert.equal(row.premium_pct, -10);
  assert.equal(row.token_price_usd, 80);

  const replaced = applyJupPremiums(base, quotes(90, 100), NOW, {
    replaceTokenPrice: true,
  });
  assert.equal(replaced.find((p) => p.name === "Anthropic")?.token_price_usd, 90);
});

test("fresh SpaceX stockData without a reference token is not a live premium", () => {
  const products = buildProducts([], quotes(122.05, 167.16), NOW);
  const sx = products.find((p) => p.name === "SpaceX");
  assert.ok(sx);
  assert.equal(sx.premium_source, "hardcoded_fallback");
  assert.equal(sx.mark_price_usd, null);
  assert.equal(sx.premium_pct, HARDCODED_PREMIUMS_PCT.SpaceX);
  const anth = products.find((p) => p.name === "Anthropic");
  assert.equal(anth?.premium_source, "jupiter_stockdata");
  assert.equal(anth?.mark_price_usd, 167.16);
  assert.equal(anth?.premium_pct, Math.round((122.05 / 167.16 - 1) * 100 * 1000) / 1000);
});

test("SpaceX mark is the SPCXx token price, and a stale primary uses SPCX", () => {
  const freshAt = new Date(NOW - 3_600_000).toISOString();
  const raw: Record<string, unknown> = {};
  for (const [name, mint] of Object.entries(MINTS)) {
    raw[mint] = {
      usdPrice: name === "SpaceX" ? 122.05 : 80,
      liquidity: 80_000,
      stockData: {
        id: "prestocks",
        price: name === "SpaceX" ? 167.16 : 100,
        updatedAt: freshAt,
      },
    };
  }
  raw[REFERENCE_MINTS.SpaceX.primary] = {
    usdPrice: 144.46,
    stockData: { id: "xstocks", price: 167.16, updatedAt: freshAt },
  };
  raw[REFERENCE_MINTS.SpaceX.backup] = {
    usdPrice: 150,
    stockData: { id: "backpack", price: 151, updatedAt: freshAt },
  };
  const parsed = parseJupResponse(raw, NOW);
  const products = buildProducts([], parsed, NOW);
  const sx = products.find((p) => p.name === "SpaceX");
  assert.ok(sx);
  assert.equal(sx.mark_price_usd, 144.46);
  assert.equal(sx.token_price_usd, 122.05);
  assert.equal(sx.premium_source, "jupiter_stockdata");
  assert.equal(
    sx.premium_pct,
    Math.round((122.05 / 144.46 - 1) * 100 * 1000) / 1000,
  );
  const anth = products.find((p) => p.name === "Anthropic");
  assert.equal(anth?.mark_price_usd, 100);
  assert.equal(anth?.premium_pct, -20);

  const stalePrimary = parseJupResponse(raw, NOW);
  stalePrimary.SpaceX.refUpdatedAt = NOW - 73 * 60 * 60 * 1000;
  const overlaid = applyJupPremiums(products, stalePrimary, NOW);
  const backed = overlaid.find((p) => p.name === "SpaceX");
  assert.equal(backed?.mark_price_usd, 150);
  assert.equal(backed?.premium_source, "jupiter_stockdata");
  assert.equal(
    backed?.premium_pct,
    Math.round((122.05 / 150 - 1) * 100 * 1000) / 1000,
  );

  const neither = parseJupResponse(raw, NOW);
  neither.SpaceX.refUpdatedAt = NOW - 73 * 60 * 60 * 1000;
  neither.SpaceX.refBackupUpdatedAt = NOW - 73 * 60 * 60 * 1000;
  const dropped = applyJupPremiums(
    products.map((p) =>
      p.name === "SpaceX"
        ? { ...p, mark_price_usd: 1, premium_pct: 0, premium_source: "jupiter_stockdata" }
        : p,
    ),
    neither,
    NOW,
  );
  const missing = dropped.find((p) => p.name === "SpaceX");
  assert.equal(missing?.mark_price_usd, 1);
  assert.equal(missing?.premium_source, "jupiter_stockdata");
});
