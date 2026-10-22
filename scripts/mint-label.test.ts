import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";
import { translate } from "../lib/i18n";
import { mintLabel } from "../lib/mint-label";
import { shortPk } from "../lib/predca";

const SPACEX = "6CeRGMDMex7utcfKqwXnXncqcWYkKYss7SuocJi1oMQn";
const FIGURE = "Ea2yntPKjKE5Ako2qBX5axHi9dr1bcsGSYENjpZjeUak";

function dictKeys(which: "pl" | "en"): string[] {
  const src = readFileSync(new URL("../lib/i18n.tsx", import.meta.url), "utf8");
  const start = src.indexOf(which === "pl" ? "const pl: Dict" : "const en: Dict");
  const end = src.indexOf(which === "pl" ? "const en: Dict" : "const dictionaries");
  return [...src.slice(start, end).matchAll(/^\s*"([^"]+)":/gm)].map((hit) => hit[1]);
}

test("known mint uses the company name for a string and a PublicKey", () => {
  assert.equal(mintLabel(SPACEX), "SpaceX");
  assert.equal(mintLabel(new PublicKey(SPACEX)), "SpaceX");
  assert.equal(mintLabel(FIGURE, 6), "Figure AI");
  assert.equal(mintLabel(new PublicKey(FIGURE), 6), "Figure AI");
});

test("unknown mint falls back to a short address", () => {
  const unknown = new PublicKey("11111111111111111111111111111111");
  const asString = unknown.toBase58();
  assert.equal(mintLabel(asString), shortPk(asString));
  assert.equal(mintLabel(unknown), shortPk(unknown));
  assert.equal(mintLabel(asString, 6), shortPk(asString, 6));
  assert.equal(mintLabel(unknown, 6), shortPk(unknown, 6));
  assert.equal(mintLabel(asString), "1111…1111");
  assert.equal(mintLabel(asString, 6), "111111…111111");
  assert.notEqual(mintLabel(asString), asString);
});

test("mint address tooltip has the same key in Polish and English", () => {
  const plKeys = dictKeys("pl");
  const enKeys = dictKeys("en");
  assert.deepEqual(plKeys, enKeys);
  assert.equal(plKeys.includes("predca.runMintAddress"), true);
  const mint = SPACEX;
  assert.equal(translate("pl", "predca.runMintAddress", { mint }), `Adres mintu: ${mint}`);
  assert.equal(translate("en", "predca.runMintAddress", { mint }), `Mint address: ${mint}`);
});
