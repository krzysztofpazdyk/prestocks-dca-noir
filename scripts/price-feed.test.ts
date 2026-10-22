import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  PRICE_FEED_CACHE_MS,
  PRICE_FEED_DISC,
  PRICE_FEED_LEN,
  clearPriceFeedCache,
  fetchPriceFeedsCached,
  mintedBaseUnits,
} from "../lib/price-feed";

function feedAccount(mint: PublicKey, owner: PublicKey, price: bigint) {
  const data = new Uint8Array(PRICE_FEED_LEN);
  data.set(PRICE_FEED_DISC, 0);
  data.set(mint.toBytes(), 8);
  new DataView(data.buffer).setBigUint64(40, price, true);
  data[48] = 6;
  return { data, owner };
}

test("mintedBaseUnits: $100 at $50 (6 decimals) is 2.0 tokens", () => {
  assert.equal(mintedBaseUnits(BigInt(100_000_000), BigInt(50_000_000), 6), BigInt(2_000_000));
  assert.equal(mintedBaseUnits(BigInt(100_000_000), BigInt(0), 6), BigInt(0));
  assert.equal(mintedBaseUnits(BigInt(100_000_000), BigInt(50_000_000), -1), BigInt(0));
});

test("PriceFeed cache skips RPC for 30s", async () => {
  clearPriceFeedCache();
  const program = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  let calls = 0;
  const connection = {
    async getMultipleAccountsInfo() {
      calls += 1;
      return [feedAccount(mint, program, BigInt(50_000_000))];
    },
  };
  const now = 1_000_000;
  const first = await fetchPriceFeedsCached(connection, [mint], now, program);
  const second = await fetchPriceFeedsCached(
    connection,
    [mint],
    now + PRICE_FEED_CACHE_MS - 1,
    program,
  );
  assert.equal(calls, 1);
  assert.equal(first[0]?.price, BigInt(50_000_000));
  assert.equal(second[0]?.price, BigInt(50_000_000));
  await fetchPriceFeedsCached(connection, [mint], now + PRICE_FEED_CACHE_MS, program);
  assert.equal(calls, 2);
  clearPriceFeedCache();
});
