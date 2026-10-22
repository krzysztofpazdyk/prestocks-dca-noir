import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import {
  fetchMockTokenBalances,
  fetchUserConfig,
  isRateOrNetworkError,
  isRpcDisconnect,
} from "../lib/predca";
import {
  commitRefreshRead,
  flightMayRelease,
  postTxReadAttempt,
  retryRefresh,
} from "../lib/predca-refresh";
import {
  EMPTY_SNAPSHOT,
  RPC_TIMEOUT_WARNING_KEY,
  derivePredcaStatus,
  nextSnapshotAfterRefresh,
  type PredcaSnapshot,
} from "../lib/predca-status";
import {
  portfolioTileState,
  portfolioUsdForWallet,
  type PositionRow,
} from "../lib/position-value";
import { purchaseDisabledReasonKey } from "../lib/purchase-reason";
import { fetchRunPrices } from "../lib/run-price";
import {
  RPC_READ_TIMEOUT_MS,
  RPC_REFRESH_BUDGET_MS,
  RpcTimeoutError,
  isRpcTimeout,
  readTimeoutMs,
  refreshDeadline,
  withTimeout,
} from "../lib/rpc-timeout";

function snap(partial: Partial<PredcaSnapshot> = {}): PredcaSnapshot {
  return {
    ...EMPTY_SNAPSHOT,
    configState: "present",
    vaultUsdc: 10,
    config: { weeklyBudgetUsdc: 1 } as PredcaSnapshot["config"],
    ...partial,
  };
}

const purchaseBase = {
  purchaseDisabled: true,
  sigUnresolved: false,
  buyInFlight: false,
  txPending: false,
  statusError: false,
  rankFlat: false,
  top3Empty: false,
  connected: true,
  onChainReady: true,
  vaultTooLow: false,
};

test("withTimeout returns a fast result and clears the timer", async () => {
  const original = globalThis.clearTimeout;
  let cleared = 0;
  globalThis.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => {
    cleared += 1;
    return original(handle);
  }) as typeof clearTimeout;
  try {
    assert.equal(await withTimeout(Promise.resolve(42), 5_000, "fast"), 42);
    assert.ok(cleared >= 1);
  } finally {
    globalThis.clearTimeout = original;
  }
});

test("withTimeout rejects RpcTimeoutError and clears that timer too", async () => {
  const original = globalThis.clearTimeout;
  let cleared = 0;
  globalThis.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => {
    cleared += 1;
    return original(handle);
  }) as typeof clearTimeout;
  try {
    const started = Date.now();
    await assert.rejects(
      () => withTimeout(new Promise(() => {}), 30, "hang"),
      (err: unknown) => {
        assert.ok(err instanceof RpcTimeoutError);
        assert.equal(isRpcTimeout(err), true);
        assert.equal((err as Error).name, "RpcTimeoutError");
        return true;
      },
    );
    assert.ok(Date.now() - started < 1_000);
    assert.ok(cleared >= 1);
  } finally {
    globalThis.clearTimeout = original;
  }
});

test("a late settle after timeout is swallowed", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    let rejectLate: (err: unknown) => void = () => {};
    let resolveLate: (value: string) => void = () => {};
    const lateReject = new Promise<never>((_, reject) => {
      rejectLate = reject;
    });
    await assert.rejects(
      () => withTimeout(lateReject, 20, "late-reject"),
      (err: unknown) => err instanceof RpcTimeoutError,
    );
    rejectLate(new Error("late boom"));

    const lateResolve = new Promise<string>((resolve) => {
      resolveLate = resolve;
    });
    await assert.rejects(
      () => withTimeout(lateResolve, 20, "late-resolve"),
      (err: unknown) => err instanceof RpcTimeoutError,
    );
    resolveLate("too late");
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("withTimeout lets the original rejection through unchanged", async () => {
  const err = new Error("boom");
  await assert.rejects(
    () => withTimeout(Promise.reject(err), 500, "boom"),
    (got) => got === err,
  );
});

test("shared refresh budget stays within one pass, not the sum of per-read caps", () => {
  assert.equal(RPC_READ_TIMEOUT_MS, 15_000);
  assert.ok(RPC_READ_TIMEOUT_MS >= 15_000 && RPC_READ_TIMEOUT_MS <= 20_000);
  assert.equal(RPC_REFRESH_BUDGET_MS, 20_000);
  const start = 5_000_000;
  const deadline = refreshDeadline(start);
  assert.equal(deadline - start, RPC_REFRESH_BUDGET_MS);
  let now = start;
  let spent = 0;
  for (let i = 0; i < 6; i++) {
    const slice = readTimeoutMs(deadline, now);
    assert.ok(slice <= RPC_READ_TIMEOUT_MS);
    if (slice === 0) break;
    spent += slice;
    now += slice;
  }
  assert.equal(spent, RPC_REFRESH_BUDGET_MS);
  assert.ok(RPC_READ_TIMEOUT_MS * 3 > RPC_REFRESH_BUDGET_MS);
  assert.equal(readTimeoutMs(deadline, start), RPC_READ_TIMEOUT_MS);
  assert.equal(readTimeoutMs(deadline, start + 16_000), 4_000);
  assert.equal(readTimeoutMs(deadline, deadline), 0);
});

test("RpcTimeoutError is a rate-or-network error and an RPC disconnect", () => {
  const timeout = new RpcTimeoutError("sol");
  assert.equal(isRateOrNetworkError(timeout), true);
  assert.equal(isRpcDisconnect(timeout, timeout.message), true);
  assert.equal(isRateOrNetworkError(new Error("nope")), false);
  assert.equal(isRpcDisconnect(new Error("nope"), "nope"), false);
  assert.equal(isRateOrNetworkError(new Error("HTTP 429 Too Many Requests")), true);
  const buried = `signature ${"5".repeat(40)}429${"5".repeat(40)} failed locally`;
  assert.equal(isRateOrNetworkError(new Error(buried)), false);
  assert.equal(isRpcDisconnect(new Error(buried), buried), false);
  assert.equal(isRpcDisconnect(new Error("429"), "429"), true);
});

test("a hung token-balance read times out as unknown and does not hang", async () => {
  const owner = Keypair.generate().publicKey;
  const started = Date.now();
  const read = await fetchMockTokenBalances(
    {
      getMultipleAccountsInfo: () => new Promise(() => {}),
    } as unknown as Connection,
    owner,
    [{ name: "OpenAI", mint: PublicKey.unique() }],
    { timeoutMs: 40 },
  );
  assert.equal(read.status, "unknown");
  assert.notEqual(read.status, "error");
  assert.equal(read.detail, "balances.warning");
  assert.ok(Date.now() - started < 1_000);
});

test("fetchUserConfig and fetchRunPrices time out instead of hanging", async () => {
  const owner = PublicKey.unique();
  const started = Date.now();
  await assert.rejects(
    () =>
      fetchUserConfig(
        {
          account: {
            userConfig: { fetchNullable: () => new Promise(() => {}) },
          },
        } as unknown as Parameters<typeof fetchUserConfig>[0],
        owner,
        30,
      ),
    (err: unknown) => err instanceof RpcTimeoutError,
  );
  const prices = await fetchRunPrices(
    {
      getMultipleAccountsInfo: () => new Promise(() => {}),
    } as unknown as Connection,
    owner,
    [1, 2],
    30,
  );
  assert.equal(prices.ok, false);
  assert.ok(Date.now() - started < 1_000);
});

test("a soft timeout keeps the snapshot and does not become status error", () => {
  const prevPrices = new Map<number, string | null>([[1, "keep"]]);
  const prev = snap({
    balanceWarning: "balances.warning",
    priceWarning: null,
    vaultUsdc: 9,
  });
  const soft = commitRefreshRead({
    prevSnapshot: prev,
    prevPrices,
    outcome: { ok: false, soft: true },
    prices: { map: new Map([[1, "dropped"]]), ok: false },
    runMeta: [{ runIndex: 2, ts: 9 }],
    nowMs: 1_700_000_000_000,
  });
  assert.equal(soft.snapshot.vaultUsdc, 9);
  assert.equal(soft.snapshot.rpcError, null);
  assert.equal(soft.snapshot.rpcWarning, RPC_TIMEOUT_WARNING_KEY);
  assert.equal(soft.snapshot.balanceWarning, "balances.warning");
  assert.equal(soft.snapshot.priceWarning ?? null, null);
  assert.equal(soft.prices.get(1), "keep");
  assert.equal(
    derivePredcaStatus({
      hasOwner: true,
      hasMint: true,
      loading: false,
      configState: soft.snapshot.configState,
      rpcError: soft.snapshot.rpcError,
    }),
    "ready",
  );

  const cleared = nextSnapshotAfterRefresh(soft.snapshot, {
    ok: true,
    config: prev.config,
    vaultUsdc: 12,
    ownerUsdc: 1,
    solBalance: 0.1,
    tokenBalances: [],
    runs: [],
  });
  assert.equal(cleared.rpcWarning, null);
  assert.equal(cleared.balanceWarning, null);
  assert.equal(cleared.rpcError, null);
  assert.equal(cleared.vaultUsdc, 12);

  const hard = nextSnapshotAfterRefresh(soft.snapshot, {
    ok: false,
    error: "rpc down",
  });
  assert.equal(hard.rpcError, "rpc down");
  assert.equal(hard.vaultUsdc, 9);
  assert.equal(hard.balanceWarning, "balances.warning");
  assert.equal(
    derivePredcaStatus({
      hasOwner: true,
      hasMint: true,
      loading: false,
      configState: hard.configState,
      rpcError: hard.rpcError,
    }),
    "error",
  );
});

test("the first load stays loading after a soft timeout, with the warning and no rpcError", () => {
  const first = nextSnapshotAfterRefresh(EMPTY_SNAPSHOT, { ok: false, soft: true });
  assert.equal(first.configState, "unknown");
  assert.equal(first.rpcError, null);
  assert.equal(first.rpcWarning, "rpc.timeoutWarning");
  assert.equal(
    derivePredcaStatus({
      hasOwner: true,
      hasMint: true,
      loading: false,
      configState: first.configState,
      rpcError: first.rpcError,
    }),
    "loading",
  );
});

test("a soft timeout does not add a manual-buy block reason", () => {
  const timedOut = nextSnapshotAfterRefresh(snap(), { ok: false, soft: true });
  const status = derivePredcaStatus({
    hasOwner: true,
    hasMint: true,
    loading: false,
    configState: timedOut.configState,
    rpcError: timedOut.rpcError,
  });
  assert.notEqual(status, "error");
  assert.equal(timedOut.rpcError, null);
  assert.notEqual(
    purchaseDisabledReasonKey({ ...purchaseBase, statusError: status === "error" }),
    "purchase.disabled.rpcError",
  );
  assert.equal(
    purchaseDisabledReasonKey({ ...purchaseBase, statusError: true }),
    "purchase.disabled.rpcError",
  );
});

test("portfolio tile is unknown for stale balances, and price copy stays the price cause", () => {
  const balances = portfolioTileState({
    priceWarning: null,
    balanceWarning: "balances.warning",
    positions: [{ valueKnown: true }],
  });
  assert.equal(balances.unknown, true);
  assert.equal(balances.reason, "balances");
  assert.equal(balances.priceUnknown, false);
  assert.equal(balances.balancesStale, true);

  const price = portfolioTileState({
    priceWarning: "runPrice.loading",
    balanceWarning: null,
    positions: [{ valueKnown: true }],
  });
  assert.equal(price.unknown, true);
  assert.equal(price.reason, "price");
  assert.equal(price.priceUnknown, true);

  const unknownRow = portfolioTileState({
    priceWarning: null,
    balanceWarning: null,
    positions: [{ valueKnown: false }],
  });
  assert.equal(unknownRow.reason, "price");
  assert.equal(unknownRow.unknown, true);

  // Both: balances win. The figure would be summed from the previous read.
  const both = portfolioTileState({
    priceWarning: "runPrice.loading",
    balanceWarning: "balances.warning",
    positions: [{ valueKnown: false }],
  });
  assert.equal(both.unknown, true);
  assert.equal(both.reason, "balances");
  assert.equal(both.priceUnknown, true);
  assert.equal(both.balancesStale, true);

  const known = portfolioTileState({
    priceWarning: null,
    balanceWarning: null,
    positions: [{ valueKnown: true }],
  });
  assert.equal(known.unknown, false);
  assert.equal(known.reason, null);
});

test("portfolio USD is null while balances are stale", () => {
  const row = { name: "Anthropic", valueUsd: 50, valueKnown: true } as PositionRow;
  assert.equal(
    portfolioUsdForWallet({
      hasOwner: true,
      priceWarning: null,
      balanceWarning: null,
      vaultUsdc: 20,
      positions: [row],
    }),
    70,
  );
  assert.equal(
    portfolioUsdForWallet({
      hasOwner: true,
      priceWarning: null,
      balanceWarning: "balances.warning",
      vaultUsdc: 20,
      positions: [row],
    }),
    null,
  );
  assert.equal(
    portfolioUsdForWallet({
      hasOwner: true,
      priceWarning: "runPrice.loading",
      balanceWarning: null,
      vaultUsdc: 20,
      positions: [row],
    }),
    null,
  );
});

test("a soft timeout is not settled and the post-tx retry still stops at 3", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const result = await retryRefresh({
    still: () => true,
    refresh: async () => {
      calls += 1;
      return postTxReadAttempt({
        snapshot: { rpcError: null },
        softTimeout: true,
      });
    },
    settled: () => {
      throw new Error("soft timeout must not be settled");
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(calls, 3);
  assert.equal(result.attempts, 3);
  assert.equal(result.settled, false);
  assert.equal(result.last, null);
  assert.equal(sleeps.length, 2);

  const settled = await retryRefresh({
    still: () => true,
    refresh: async () =>
      postTxReadAttempt({
        snapshot: { rpcError: null },
      }),
    settled: () => true,
    sleep: async () => {
      throw new Error("a real read should settle without sleeping");
    },
  });
  assert.equal(settled.attempts, 1);
  assert.equal(settled.settled, true);
  assert.equal(postTxReadAttempt({ snapshot: { rpcError: "down" } }), null);
});

test("a stale flight generation must not release in-flight flags", () => {
  assert.equal(flightMayRelease(4, 4), true);
  assert.equal(flightMayRelease(5, 4), false);
  let released = false;
  const myGen = 1;
  const currentGen = 2;
  if (flightMayRelease(currentGen, myGen)) released = true;
  assert.equal(released, false);
});

test("refresh wires timeouts and the portfolio tile splits the two causes", () => {
  const hook = readFileSync(new URL("../lib/hooks/usePredca.ts", import.meta.url), "utf8");
  const refreshAt = hook.indexOf("const refresh = useCallback");
  const refreshFn = hook.slice(refreshAt, hook.indexOf("void refresh()"));
  assert.match(refreshFn, /withTimeout\(/);
  assert.match(refreshFn, /refreshDeadline\(/);
  assert.match(refreshFn, /isRpcTimeout\(e\)/);
  assert.match(refreshFn, /soft:\s*true/);
  assert.match(refreshFn, /if \(!nested && flightGen\.current === myGen\)/);
  assert.match(refreshFn, /await fetchUserConfig/);
  assert.match(refreshFn, /await fetchRunPrices/);
  for (const name of ["solPromise", "ownerBalPromise", "tokensPromise"]) {
    const decl = refreshFn.indexOf(`const ${name}`);
    assert.ok(decl > 0, name);
    const fetchAt = refreshFn.indexOf("await fetchUserConfig");
    assert.ok(decl < fetchAt, name);
    assert.match(refreshFn.slice(decl, fetchAt), new RegExp(`markHandled\\(${name}\\)`));
  }

  const afterStart = hook.indexOf("async function refreshAfterTx");
  const afterEnd = hook.indexOf("async function withTx", afterStart);
  const after = hook.slice(afterStart, afterEnd);
  assert.match(after, /postTxReadAttempt\(/);
  assert.match(after, /flightGen\.current === myGen/);
  assert.equal(after.includes("setTxPending"), false);
  assert.equal(after.includes("txPendingRef"), false);

  const buy = hook.slice(
    hook.indexOf("async function simulateBuy"),
    hook.indexOf("function clearToasts"),
  );
  assert.match(buy, /if \(rpcError\)/);
  assert.equal(buy.includes("rpcWarning"), false);

  const overview = readFileSync(
    new URL("../components/OverviewView.tsx", import.meta.url),
    "utf8",
  );
  assert.match(overview, /portfolioPriceUnknown \? <p>\{t\("runPrice\.loading"\)\}<\/p>/);
  assert.doesNotMatch(overview, /portfolioUnknown && <p>\{t\("runPrice\.loading"\)\}<\/p>/);
  assert.match(overview, /t\("portfolio\.staleHint"\)/);
  assert.match(overview, /t\(predca\.rpcWarning\)/);
  assert.match(overview, /disabled=\{!connected \|\| predca\.loading\}/);
  const warnAt = overview.indexOf("t(predca.rpcWarning)");
  assert.ok(warnAt > 0);
  assert.match(overview.slice(warnAt - 160, warnAt), /text-\[#fbbf24\]/);
  assert.doesNotMatch(overview.slice(warnAt - 160, warnAt + 40), /TxNotice/);

  const provider = readFileSync(
    new URL("../components/SolanaWalletProvider.tsx", import.meta.url),
    "utf8",
  );
  assert.equal(provider.includes("withTimeout"), false);
  assert.equal(provider.includes("rpc-timeout"), false);
});
