import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { AccountLayout } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { historyBudgetUsd, historyLegUsd } from "../lib/history-view";
import { emptyJupPrices } from "../lib/jup-prices";
import {
  buildPositions,
  portfolioUsdKnown,
  runLots,
  tokenBalancesCoverLots,
} from "../lib/position-value";
import {
  fetchMockTokenBalances,
  parseAnchorError,
  rawTokenAmount,
  TOKEN_BALANCE_BATCH,
  type MockTokenBalance,
} from "../lib/predca";
import {
  buyRefreshSettled,
  chainPollDecision,
  CHAIN_POLL_MS,
  commitRefreshRead,
  POST_TX_REFRESH_ATTEMPTS,
  POST_TX_REFRESH_GAP_MS,
  pricesAfterRead,
  retryRefresh,
  vaultMoved,
} from "../lib/predca-refresh";
import {
  EMPTY_SNAPSHOT,
  nextSnapshotAfterRefresh,
  type PredcaSnapshot,
} from "../lib/predca-status";
import { fillsFor } from "../lib/run-fills";
import { effectiveRunPricePresence, isYoungRunTs } from "../lib/run-price";

const ANTHROPIC = "3MFLVffGvwRVpo4iGvALruCwZmQQvSDuwyFqgiaknZ5V";
const NOW = 1_700_000_000_000;

function connectionWith(impl: Partial<Connection>): Connection {
  return impl as Connection;
}

function tokenData(amount: bigint): Buffer {
  const data = Buffer.alloc(AccountLayout.span);
  data.writeBigUInt64LE(amount, 64);
  return data;
}

function snap(partial: Partial<PredcaSnapshot> = {}): PredcaSnapshot {
  return { ...EMPTY_SNAPSHOT, configState: "present", vaultUsdc: 10, ...partial };
}

function priced(mint: string) {
  return {
    mints: [{ toBase58: () => mint }],
    prices: [BigInt(2_000_000)],
    priceDecimals: [6],
    usdcSpentEach: BigInt(4_000_000),
  };
}

test("raw token amount is the u64 at byte 64", () => {
  assert.equal(rawTokenAmount(tokenData(BigInt(2_500_000))), BigInt(2_500_000));
  assert.equal(rawTokenAmount(Uint8Array.from([1, 2, 3])), null);
});

test("state c is unknown and is not valued at 1 USD", () => {
  const runs = [{ runIndex: 1, ts: 9, mints: [ANTHROPIC], amountsUsd: [50] }];
  const lots = runLots(runs, new Map(), NOW);
  assert.equal(lots[0].priceState, "unknown");
  assert.equal(lots[0].usdcCost, 0);
  assert.equal(lots[0].units, null);
  assert.equal(lots[0].buyPrice, null);
  const rows = buildPositions(
    lots,
    [{ name: "Anthropic", amount: 50 }],
    emptyJupPrices(NOW),
  );
  assert.equal(rows[0].valueKnown, false);
  assert.equal(rows[0].valueUsd, 0);
  assert.equal(rows[0].mismatch, false);
  assert.equal(rows[0].costUsd, 0);
  assert.equal(portfolioUsdKnown(20, rows), null);
  assert.equal(
    tokenBalancesCoverLots(lots, [{ name: "Anthropic", amount: 50 }]),
    false,
  );
  assert.equal(fillsFor(runs, new Map(), NOW)[0].priceState, "unknown");
  assert.equal(historyLegUsd("unknown", undefined, 50), null);
  assert.equal(historyBudgetUsd("unknown", [50]), null);
});

test("state b stays legacy 1:1 and state a stays priced", () => {
  const runs = [{ runIndex: 1, ts: 9, mints: [ANTHROPIC], amountsUsd: [50] }];
  const legacy = runLots(runs, new Map([[1, null]]), NOW);
  assert.equal(legacy[0].priceState, "legacy");
  assert.equal(legacy[0].usdcCost, 50);
  assert.equal(legacy[0].units, null);
  const legacyRows = buildPositions(
    legacy,
    [{ name: "Anthropic", amount: 50 }],
    emptyJupPrices(NOW),
  );
  assert.equal(legacyRows[0].valueKnown, true);
  assert.equal(legacyRows[0].valueUsd, 50);
  assert.equal(legacyRows[0].mismatch, false);
  assert.equal(portfolioUsdKnown(20, legacyRows), 70);

  const short = buildPositions(
    legacy,
    [{ name: "Anthropic", amount: 40 }],
    emptyJupPrices(NOW),
  );
  assert.equal(short[0].mismatch, true);
  assert.equal(short[0].valueKnown, true);
  assert.equal(short[0].valueUsd, 40);

  const extra = buildPositions(
    legacy,
    [{ name: "Anthropic", amount: 60 }],
    emptyJupPrices(NOW),
  );
  assert.equal(extra[0].mismatch, true);
  assert.equal(extra[0].valueUsd, 60);
  assert.equal(extra[0].valueKnown, true);

  const decoded = runLots(runs, new Map([[1, priced(ANTHROPIC)]]), NOW);
  assert.equal(decoded[0].priceState, "priced");
  assert.equal(decoded[0].units, 50);
  assert.equal(decoded[0].usdcCost, 4);
  assert.equal(fillsFor([{ ...runs[0], tokenAmounts: [50] }], new Map([[1, priced(ANTHROPIC)]]), NOW)[0].priceState, "priced");
  assert.equal(historyLegUsd("legacy", undefined, 50), 50);
  assert.equal(historyLegUsd("priced", 4, 50), 4);
  assert.equal(historyBudgetUsd("priced", [4, 4]), 8);
});

test("a young confirmed-missing RunPrice stays unknown", () => {
  const ts = Math.floor(NOW / 1000);
  assert.equal(isYoungRunTs(ts, NOW), true);
  assert.equal(isYoungRunTs(9, NOW), false);
  assert.equal(
    effectiveRunPricePresence(new Map([[1, null]]), 1, ts, NOW),
    "unknown",
  );
  assert.equal(
    effectiveRunPricePresence(new Map([[1, null]]), 1, 9, NOW),
    "missing",
  );
  const lots = runLots(
    [{ runIndex: 1, ts, mints: [ANTHROPIC], amountsUsd: [50] }],
    new Map([[1, null]]),
    NOW,
  );
  assert.equal(lots[0].priceState, "unknown");
  assert.equal(lots[0].usdcCost, 0);
});

test("prices and the snapshot commit together, and ok false keeps the previous map", () => {
  const prevPrices = new Map<number, string | null>([[1, "keep"]]);
  const failed = commitRefreshRead({
    prevSnapshot: snap({ vaultUsdc: 10, priceWarning: null }),
    prevPrices,
    outcome: { ok: false, error: "rpc down" },
    prices: { map: new Map([[1, null]]), ok: false },
    runMeta: [{ runIndex: 2, ts: 9 }],
    nowMs: NOW,
  });
  assert.equal(failed.snapshot.vaultUsdc, 10);
  assert.equal(failed.snapshot.rpcError, "rpc down");
  assert.equal(failed.prices.get(1), "keep");

  const soft = commitRefreshRead({
    prevSnapshot: snap(),
    prevPrices,
    outcome: {
      ok: true,
      config: null,
      vaultUsdc: 4,
      ownerUsdc: null,
      solBalance: null,
      tokenBalances: [],
      runs: [],
    },
    prices: { map: new Map([[2, null]]), ok: false },
    runMeta: [{ runIndex: 2, ts: 9 }],
    nowMs: NOW,
  });
  assert.equal(soft.snapshot.vaultUsdc, 4);
  assert.equal(soft.snapshot.rpcError, null);
  assert.equal(soft.snapshot.priceWarning, "runPrice.loading");
  assert.equal(soft.prices.get(1), "keep");
  assert.equal(soft.prices.has(2), false);

  const youngTs = Math.floor(NOW / 1000);
  const dropped = pricesAfterRead(
    prevPrices,
    { map: new Map<number, string | null>([[3, null]]), ok: true },
    [{ runIndex: 3, ts: youngTs }],
    NOW,
  );
  assert.equal(dropped.has(3), false);
  const keptNull = pricesAfterRead(
    new Map(),
    { map: new Map<number, string | null>([[3, null]]), ok: true },
    [{ runIndex: 3, ts: 9 }],
    NOW,
  );
  assert.equal(keptNull.get(3), null);
  const pricedCommit = commitRefreshRead({
    prevSnapshot: snap(),
    prevPrices: new Map(),
    outcome: {
      ok: true,
      config: null,
      vaultUsdc: 4,
      ownerUsdc: null,
      solBalance: null,
      tokenBalances: [],
      runs: [],
    },
    prices: { map: keptNull, ok: true },
    runMeta: [{ runIndex: 3, ts: 9 }],
    nowMs: NOW,
  });
  assert.equal(pricedCommit.snapshot.priceWarning, null);
  assert.equal(pricedCommit.prices.get(3), null);
});

test("a stale token read keeps the previous balances and does not set rpcError", () => {
  const prev: MockTokenBalance = {
    name: "Anthropic",
    mint: PublicKey.unique(),
    amount: 3,
    raw: BigInt(3_000_000),
  };
  const next = nextSnapshotAfterRefresh(snap({ tokenBalances: [prev] }), {
    ok: true,
    config: null,
    vaultUsdc: 4,
    ownerUsdc: null,
    solBalance: null,
    tokenBalances: [],
    tokenBalancesStale: true,
    runs: [],
  });
  assert.equal(next.tokenBalances[0].amount, 3);
  assert.equal(next.balanceWarning, "balances.warning");
  assert.equal(next.rpcError, null);
  assert.equal(next.vaultUsdc, 4);
});

test("post-buy retry stops at three attempts and still() blocks a stale write", async () => {
  assert.equal(POST_TX_REFRESH_ATTEMPTS, 3);
  assert.ok(POST_TX_REFRESH_GAP_MS >= 2_000 && POST_TX_REFRESH_GAP_MS <= 3_000);
  const sleeps: number[] = [];
  const open = await retryRefresh({
    still: () => true,
    refresh: async () => 1,
    settled: () => false,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(open.attempts, 3);
  assert.equal(open.settled, false);
  assert.equal(open.last, 1);
  assert.deepEqual(sleeps, [POST_TX_REFRESH_GAP_MS, POST_TX_REFRESH_GAP_MS]);

  const early = await retryRefresh({
    still: () => true,
    refresh: async () => 7,
    settled: (value) => value === 7,
    sleep: async () => {
      throw new Error("slept after settle");
    },
  });
  assert.equal(early.attempts, 1);
  assert.equal(early.settled, true);

  let alive = true;
  const dropped = await retryRefresh({
    still: () => alive,
    refresh: async () => {
      alive = false;
      return 1;
    },
    settled: () => true,
    sleep: async () => {
      throw new Error("slept after epoch change");
    },
  });
  assert.equal(dropped.attempts, 1);
  assert.equal(dropped.settled, false);
  assert.equal(
    (
      await retryRefresh({
        still: () => false,
        refresh: async () => 1,
        settled: () => true,
      })
    ).attempts,
    0,
  );
});

test("buy settlement needs the new run, a decoded price, and enough tokens", () => {
  const run = { runIndex: 4, ts: 9, mints: [ANTHROPIC], amountsUsd: [2] };
  const base = {
    prevRunCount: 4,
    expectedRunIndex: 4,
    runs: [run],
    balances: [{ name: "Anthropic", amount: 2 }],
    nowMs: NOW,
  };
  assert.equal(
    buyRefreshSettled({ ...base, prices: new Map([[4, priced(ANTHROPIC)]]) }),
    true,
  );
  assert.equal(buyRefreshSettled({ ...base, prices: new Map() }), false);
  assert.equal(
    buyRefreshSettled({
      ...base,
      runs: [{ ...run, ts: Math.floor(NOW / 1000) }],
      prices: new Map([[4, null]]),
    }),
    false,
  );
  assert.equal(
    buyRefreshSettled({
      ...base,
      prices: new Map([[4, priced(ANTHROPIC)]]),
      balances: [{ name: "Anthropic", amount: 0.5 }],
    }),
    false,
  );
  assert.equal(vaultMoved(1, 2, "up"), true);
  assert.equal(vaultMoved(2, 1, "down"), true);
  assert.equal(vaultMoved(null, 2, "up"), false);
  assert.equal(vaultMoved(1, 1, "up"), false);
});

test("chain poll runs only on a visible idle tab", () => {
  assert.ok(CHAIN_POLL_MS >= 30_000 && CHAIN_POLL_MS <= 60_000);
  assert.equal(
    chainPollDecision({
      visibilityState: "hidden",
      txPending: false,
      loading: false,
      refreshInFlight: false,
    }),
    "skip",
  );
  assert.equal(
    chainPollDecision({
      visibilityState: "visible",
      txPending: true,
      loading: false,
      refreshInFlight: false,
    }),
    "skip",
  );
  assert.equal(
    chainPollDecision({
      visibilityState: "visible",
      txPending: false,
      loading: true,
      refreshInFlight: false,
    }),
    "skip",
  );
  assert.equal(
    chainPollDecision({
      visibilityState: "visible",
      txPending: false,
      loading: false,
      refreshInFlight: true,
    }),
    "skip",
  );
  assert.equal(
    chainPollDecision({
      visibilityState: "visible",
      txPending: false,
      loading: false,
      refreshInFlight: false,
    }),
    "poll",
  );
});

test("fetchMockTokenBalances uses one batched read, null is zero, and 429 is not fatal", async () => {
  const owner = PublicKey.unique();
  const entries = Array.from({ length: 8 }, (_, i) => ({
    name: `T${i}`,
    mint: PublicKey.unique(),
  }));
  let calls = 0;
  const ok = await fetchMockTokenBalances(
    connectionWith({
      getMultipleAccountsInfo: async (keys) => {
        calls += 1;
        assert.equal(keys.length, 8);
        return keys.map((_, i) => {
          if (i === 1) return null;
          return {
            data: tokenData(BigInt((8 - i) * 1_000_000)),
            executable: false,
            lamports: 0,
            owner: PublicKey.unique(),
          };
        });
      },
    }),
    owner,
    entries,
  );
  assert.equal(calls, 1);
  assert.equal(ok.status, "ok");
  assert.equal(ok.balances.length, 8);
  const missing = ok.balances.find((row) => row.name === "T1");
  assert.equal(missing?.amount, 0);
  assert.equal(missing?.raw, BigInt(0));
  assert.deepEqual(
    ok.balances.map((row) => row.name),
    ["T0", "T2", "T3", "T4", "T5", "T6", "T7", "T1"],
  );
  assert.equal(ok.balances[0].raw, BigInt(8_000_000));
  assert.equal(ok.balances[0].amount, 8);

  const many = Array.from({ length: TOKEN_BALANCE_BATCH + 1 }, (_, i) => ({
    name: `M${i}`,
    mint: PublicKey.unique(),
  }));
  const sizes: number[] = [];
  await fetchMockTokenBalances(
    connectionWith({
      getMultipleAccountsInfo: async (keys) => {
        sizes.push(keys.length);
        return keys.map(() => null);
      },
    }),
    owner,
    many,
  );
  assert.deepEqual(sizes, [TOKEN_BALANCE_BATCH, 1]);

  const limited = await fetchMockTokenBalances(
    connectionWith({
      getMultipleAccountsInfo: async () => {
        throw new Error("HTTP 429 Too Many Requests");
      },
    }),
    owner,
    entries.slice(0, 1),
  );
  assert.equal(limited.status, "unknown");
  assert.equal(limited.detail, "balances.warning");

  const coded = await fetchMockTokenBalances(
    connectionWith({
      getMultipleAccountsInfo: async () => {
        throw Object.assign(new Error("busy"), { statusCode: 429 });
      },
    }),
    owner,
    entries.slice(0, 1),
  );
  assert.equal(coded.status, "unknown");

  const undecodable = await fetchMockTokenBalances(
    connectionWith({
      getMultipleAccountsInfo: async () => [
        { data: Buffer.from([1, 2]), executable: false, lamports: 0, owner },
      ],
    }),
    owner,
    entries.slice(0, 1),
  );
  assert.equal(undecodable.status, "unknown");

  const buried = "5".repeat(40) + "429" + "5".repeat(40);
  const real = await fetchMockTokenBalances(
    connectionWith({
      getMultipleAccountsInfo: async () => {
        throw new Error(buried);
      },
    }),
    owner,
    entries.slice(0, 1),
  );
  assert.equal(real.status, "error");
  assert.match(real.detail ?? "", /429/);
});

test("429 inside a signature is not an RPC disconnect", () => {
  const buried = `signature ${"5".repeat(40)}429${"5".repeat(40)} failed locally`;
  assert.equal(parseAnchorError(new Error(buried)).includes("Brak połączenia z RPC"), false);
  assert.match(parseAnchorError(new Error("HTTP 429 Too Many Requests")), /Brak połączenia z RPC/);
  assert.match(parseAnchorError(new Error("429")), /Brak połączenia z RPC/);
  assert.match(parseAnchorError({ message: "busy", status: 429 }), /Brak połączenia z RPC/);
  assert.match(
    parseAnchorError({ message: "busy", statusCode: 429 }),
    /Brak połączenia z RPC/,
  );
  assert.match(
    parseAnchorError({ message: "busy", response: { status: 429 } }),
    /Brak połączenia z RPC/,
  );
  assert.match(parseAnchorError(new Error("failed to fetch")), /Brak połączenia z RPC/);
});

test("new copy exists in Polish and English", () => {
  const src = readFileSync(new URL("../lib/i18n.tsx", import.meta.url), "utf8");
  const pl = src.slice(src.indexOf("const pl"), src.indexOf("const en"));
  const en = src.slice(src.indexOf("const en"), src.indexOf("const dictionaries"));
  const keys = (block: string) =>
    [...block.matchAll(/"([A-Za-z0-9_.]+)":/g)].map((hit) => hit[1]);
  const plKeys = new Set(keys(pl));
  const enKeys = new Set(keys(en));
  for (const key of plKeys) assert.equal(enKeys.has(key), true, key);
  for (const key of enKeys) assert.equal(plKeys.has(key), true, key);
  for (const key of [
    "runPrice.loading",
    "runPrice.unknown",
    "history.runMetaUnknown",
    "balances.warning",
    "premium.spacex.premium",
    "premium.spacex.premiumLabel",
  ]) {
    assert.equal(plKeys.has(key), true, key);
    assert.equal(enKeys.has(key), true, key);
  }
});

test("refresh publishes RunPrice with the snapshot and polls only while visible", () => {
  const src = readFileSync(new URL("../lib/hooks/usePredca.ts", import.meta.url), "utf8");
  const refreshAt = src.indexOf("const refresh = useCallback");
  const refreshFn = src.slice(refreshAt, src.indexOf("void refresh()"));
  const priceAt = refreshFn.indexOf("await fetchRunPrices");
  const commitAt = refreshFn.lastIndexOf("commitRefreshRead");
  assert.ok(priceAt > 0 && commitAt > priceAt);
  assert.equal(refreshFn.includes("setSnapshot((prev)"), false);
  assert.match(refreshFn, /chainPollDecision|refreshInFlightRef/);
  const pollAt = src.indexOf("visibilitychange");
  assert.ok(pollAt > src.indexOf("void refresh()"));
  const pollStart = src.lastIndexOf("useEffect", pollAt);
  const poll = src.slice(pollStart, src.indexOf("const refreshPrices"));
  assert.match(poll, /visibilityState !== "visible"/);
  assert.match(poll, /clearInterval/);
  assert.match(poll, /removeEventListener\("visibilitychange"/);
  assert.match(poll, /quiet: true/);
  assert.equal(poll.includes("signMessage"), false);
  assert.equal(poll.includes("keeper"), false);
  const after = src.slice(src.indexOf("async function refreshAfterTx"));
  assert.match(after, /retryRefresh/);
  assert.match(after, /buyRefreshSettled/);
  assert.match(after, /vaultMoved/);
});
