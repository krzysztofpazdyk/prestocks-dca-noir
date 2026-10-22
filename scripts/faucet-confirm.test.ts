import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { Keypair } from "@solana/web3.js";
import {
  FAUCET_CONFIRM_MAX_MS,
  FAUCET_CONFIRM_POLL_MS,
  FAUCET_POST_TIMEOUT_MS,
  FAUCET_USDC_MIN_INCREASE,
  claimFaucetUsdc,
  faucetFundsArrived,
  readFaucetBalances,
  type FaucetBalanceRead,
} from "../lib/dca-api";
import { translate } from "../lib/i18n";
import { resetRuntimeConfigForTests } from "../lib/runtime-config";

const API = "https://faucet.example";
const WALLET = "11111111111111111111111111111111";
const UNCONFIRMED_PL =
  "Nie potwierdzono w czasie — sprawdź saldo za chwilę, nie klikaj ponownie.";
const UNCONFIRMED_EN =
  "Not confirmed in time — check the balance in a moment, do not click again.";

type Mode =
  | { kind: "abort" }
  | { kind: "network" }
  | { kind: "throw"; error: Error }
  | { kind: "status"; status: number; body: unknown };

function clock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

function install(mode: Mode, balances: () => FaucetBalanceRead) {
  const prevFetch = globalThis.fetch;
  const prevApi = process.env.NEXT_PUBLIC_DCA_API_URL;
  const prevWarn = console.warn;
  process.env.NEXT_PUBLIC_DCA_API_URL = API;
  resetRuntimeConfigForTests();
  console.warn = () => {};
  const trace: string[] = [];
  let reads = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.includes("/faucet/usdc")) {
      return new Response("no", { status: 404 });
    }
    trace.push("post");
    if (mode.kind === "abort") {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    }
    if (mode.kind === "network") {
      throw new TypeError("Failed to fetch");
    }
    if (mode.kind === "throw") throw mode.error;
    if (typeof mode.body === "string") {
      return new Response(mode.body, {
        status: mode.status,
        headers: { "Content-Type": "text/html" },
      });
    }
    return new Response(JSON.stringify(mode.body), { status: mode.status });
  }) as typeof fetch;

  const readBalances = async () => {
    reads += 1;
    trace.push("read");
    return balances();
  };

  return {
    trace,
    reads: () => reads,
    readBalances,
    restore() {
      globalThis.fetch = prevFetch;
      console.warn = prevWarn;
      if (prevApi === undefined) delete process.env.NEXT_PUBLIC_DCA_API_URL;
      else process.env.NEXT_PUBLIC_DCA_API_URL = prevApi;
      resetRuntimeConfigForTests();
    },
  };
}

function scripted(steps: FaucetBalanceRead[]): () => FaucetBalanceRead {
  let index = 0;
  return () => steps[Math.min(index++, steps.length - 1)];
}

async function withFaucet<T>(
  mode: Mode,
  balances: () => FaucetBalanceRead,
  run: (ctx: ReturnType<typeof install>) => Promise<T>,
): Promise<T> {
  const ctx = install(mode, balances);
  try {
    return await run(ctx);
  } finally {
    ctx.restore();
  }
}

function claimOpts(
  ctx: ReturnType<typeof install>,
  ticks: ReturnType<typeof clock>,
  hooks?: { onConfirming?: () => void; refresh?: () => void },
) {
  return {
    readBalances: ctx.readBalances,
    sleep: ticks.sleep,
    now: ticks.now,
    onConfirming: () => {
      ctx.trace.push("confirm");
      hooks?.onConfirming?.();
    },
    refresh: () => {
      ctx.trace.push("refresh");
      hooks?.refresh?.();
    },
  };
}

describe("faucet confirm", { concurrency: false }, () => {
  test("a USDC increase of 1000 after an aborted POST is success", async () => {
    const ticks = clock();
    let refreshed = 0;
    const result = await withFaucet(
      { kind: "abort" },
      scripted([
        { usdc: 0, sol: 1 },
        { usdc: FAUCET_USDC_MIN_INCREASE, sol: 1 },
      ]),
      async (ctx) => {
        const res = await claimFaucetUsdc(
          WALLET,
          claimOpts(ctx, ticks, {
            refresh: () => {
              refreshed += 1;
            },
          }),
        );
        assert.deepEqual(ctx.trace, ["read", "post", "confirm", "read", "refresh"]);
        assert.equal(ctx.reads(), 2);
        return res;
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.fundsArrived, true);
    assert.equal(refreshed, 1);
    assert.deepEqual(ticks.sleeps, []);
  });

  test("an aborted POST with an unchanged balance uses the new text", async () => {
    const ticks = clock();
    await withFaucet(
      { kind: "abort" },
      () => ({ usdc: 2, sol: 1 }),
      async (ctx) => {
        await assert.rejects(
          () => claimFaucetUsdc(WALLET, claimOpts(ctx, ticks)),
          (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.equal(err.message, UNCONFIRMED_PL);
            assert.equal(err.message, translate("pl", "faucet.unconfirmed"));
            assert.doesNotMatch(err.message, /API timeout/);
            return true;
          },
        );
        assert.equal(ctx.trace[0], "read");
        assert.equal(ctx.trace[1], "post");
        assert.equal(ctx.trace[2], "confirm");
        assert.equal(ctx.trace.includes("refresh"), false);
        assert.equal(ctx.reads(), Math.floor(FAUCET_CONFIRM_MAX_MS / FAUCET_CONFIRM_POLL_MS) + 2);
        assert.equal(ticks.sleeps.length, FAUCET_CONFIRM_MAX_MS / FAUCET_CONFIRM_POLL_MS);
        assert.ok(ticks.sleeps.every((ms) => ms === FAUCET_CONFIRM_POLL_MS));
        assert.equal(
          ticks.sleeps.reduce((sum, ms) => sum + ms, 0),
          FAUCET_CONFIRM_MAX_MS,
        );
      },
    );
  });

  test("504 Faucet mint timed out with a USDC increase is success", async () => {
    const ticks = clock();
    let refreshed = 0;
    const result = await withFaucet(
      {
        kind: "status",
        status: 504,
        body: { ok: false, detail: "Faucet mint timed out" },
      },
      scripted([
        { usdc: 10, sol: 0.5 },
        { usdc: 1010, sol: 0.5 },
      ]),
      async (ctx) => {
        const res = await claimFaucetUsdc(
          WALLET,
          claimOpts(ctx, ticks, {
            refresh: () => {
              refreshed += 1;
            },
          }),
        );
        assert.equal(ctx.reads() > 1, true);
        return res;
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.fundsArrived, true);
    assert.equal(refreshed, 1);
  });

  test("504 with no balance change does not treat the mint phrase as success", async () => {
    const ticks = clock();
    await withFaucet(
      {
        kind: "status",
        status: 504,
        body: { ok: false, detail: "Faucet mint timed out" },
      },
      () => ({ usdc: 10, sol: 0.5 }),
      async (ctx) => {
        await assert.rejects(
          () => claimFaucetUsdc(WALLET, claimOpts(ctx, ticks)),
          (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.equal(err.message, UNCONFIRMED_PL);
            assert.doesNotMatch(err.message, /Faucet mint timed out/);
            return true;
          },
        );
        assert.ok(ctx.reads() > 1);
      },
    );
  });

  test("429 is the server error and does not re-read the balance", async () => {
    const ticks = clock();
    let confirmed = 0;
    let refreshed = 0;
    await withFaucet(
      { kind: "status", status: 429, body: { ok: false, error: "cooldown" } },
      () => ({ usdc: 0, sol: 1 }),
      async (ctx) => {
        await assert.rejects(
          () =>
            claimFaucetUsdc(
              WALLET,
              claimOpts(ctx, ticks, {
                onConfirming: () => {
                  confirmed += 1;
                },
                refresh: () => {
                  refreshed += 1;
                },
              }),
            ),
          (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.equal(err.message, "cooldown");
            assert.doesNotMatch(err.message, /Nie potwierdzono/);
            return true;
          },
        );
        assert.deepEqual(ctx.trace, ["read", "post"]);
        assert.equal(ctx.reads(), 1);
        assert.equal(confirmed, 0);
        assert.equal(refreshed, 0);
        assert.deepEqual(ticks.sleeps, []);
      },
    );
  });

  test("a clear 500 does not re-read the balance", async () => {
    const ticks = clock();
    await withFaucet(
      { kind: "status", status: 500, body: { ok: false, error: "mint failed" } },
      () => ({ usdc: 0, sol: 1 }),
      async (ctx) => {
        await assert.rejects(
          () => claimFaucetUsdc(WALLET, claimOpts(ctx, ticks)),
          (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.equal(err.message, "mint failed");
            return true;
          },
        );
        assert.equal(ctx.reads(), 1);
        assert.equal(ctx.trace.includes("confirm"), false);
      },
    );
  });

  test("200 ok is success and does not re-read the balance", async () => {
    const ticks = clock();
    let refreshed = 0;
    const result = await withFaucet(
      {
        kind: "status",
        status: 200,
        body: {
          ok: true,
          signature: "sig123",
          amountUi: 1000,
          mint: "mint",
          wallet: WALLET,
        },
      },
      () => ({ usdc: 0, sol: 1 }),
      async (ctx) => {
        const res = await claimFaucetUsdc(
          WALLET,
          claimOpts(ctx, ticks, {
            refresh: () => {
              refreshed += 1;
            },
          }),
        );
        assert.deepEqual(ctx.trace, ["read", "post"]);
        assert.equal(ctx.reads(), 1);
        return res;
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.signature, "sig123");
    assert.equal(result.fundsArrived, undefined);
    assert.equal(refreshed, 0);
    assert.deepEqual(ticks.sleeps, []);
  });

  test("a network error confirms from a SOL increase", async () => {
    const ticks = clock();
    const result = await withFaucet(
      { kind: "network" },
      scripted([
        { usdc: 5, sol: 1 },
        { usdc: 5, sol: 1.1 },
      ]),
      (ctx) => claimFaucetUsdc(WALLET, claimOpts(ctx, ticks)),
    );
    assert.equal(result.fundsArrived, true);
    assert.equal(result.ok, true);
  });

  test("a network error with no balance change uses the new text", async () => {
    const ticks = clock();
    await withFaucet(
      { kind: "network" },
      () => ({ usdc: 5, sol: 1 }),
      async (ctx) => {
        await assert.rejects(
          () => claimFaucetUsdc(WALLET, claimOpts(ctx, ticks)),
          (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.equal(err.message, UNCONFIRMED_PL);
            assert.doesNotMatch(err.message, /nieosiągalny|unreachable|API timeout/);
            return true;
          },
        );
      },
    );
  });

  test("502 HTML confirms when SOL increased", async () => {
    const ticks = clock();
    const result = await withFaucet(
      { kind: "status", status: 502, body: "<html>bad gateway</html>" },
      scripted([
        { usdc: 1, sol: 2 },
        { usdc: 1, sol: 2.1 },
      ]),
      (ctx) => claimFaucetUsdc(WALLET, claimOpts(ctx, ticks)),
    );
    assert.equal(result.fundsArrived, true);
  });

  test("524 with no balance change uses the new text", async () => {
    const ticks = clock();
    await withFaucet(
      { kind: "status", status: 524, body: "" },
      () => ({ usdc: 1, sol: 2 }),
      async (ctx) => {
        await assert.rejects(
          () => claimFaucetUsdc(WALLET, claimOpts(ctx, ticks)),
          (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.equal(err.message, UNCONFIRMED_PL);
            return true;
          },
        );
        assert.ok(ctx.reads() > 1);
      },
    );
  });

  test("an unrelated throw is not a balance check", async () => {
    const ticks = clock();
    await withFaucet(
      { kind: "throw", error: new Error("nope") },
      () => ({ usdc: 0, sol: 1 }),
      async (ctx) => {
        await assert.rejects(
          () => claimFaucetUsdc(WALLET, claimOpts(ctx, ticks)),
          /nope/,
        );
        assert.equal(ctx.reads(), 1);
        assert.equal(ctx.trace.includes("confirm"), false);
      },
    );
  });

  test("USDC must rise by at least 1000; a SOL increase is enough on its own", () => {
    assert.equal(
      faucetFundsArrived({ usdc: 0, sol: 1 }, { usdc: 999, sol: 1 }),
      false,
    );
    assert.equal(
      faucetFundsArrived({ usdc: 0, sol: 1 }, { usdc: 1000, sol: 1 }),
      true,
    );
    assert.equal(
      faucetFundsArrived({ usdc: null, sol: 1 }, { usdc: 1000, sol: 1 }),
      true,
    );
    assert.equal(
      faucetFundsArrived({ usdc: 5, sol: 1 }, { usdc: 5, sol: 1.01 }),
      true,
    );
    assert.equal(
      faucetFundsArrived({ usdc: 5, sol: 1 }, { usdc: 5, sol: 1 }),
      false,
    );
    assert.equal(
      faucetFundsArrived(
        { usdc: null, sol: null, usdcOk: false, solOk: false },
        { usdc: 5000, sol: 3 },
      ),
      false,
    );
  });

  test("readFaucetBalances calls the USDC and SOL readers", async () => {
    const prevMint = process.env.NEXT_PUBLIC_USDC_MINT;
    process.env.NEXT_PUBLIC_USDC_MINT =
      "3xtTBfHRf8AKEmhbFYqRoXfi9RaxxiqG9YfifjCjD4qm";
    const wallet = Keypair.generate().publicKey.toBase58();
    let tokenReads = 0;
    let solReads = 0;
    const connection = {
      getTokenAccountBalance: async () => {
        tokenReads += 1;
        return { value: { uiAmountString: "4", uiAmount: 4 } };
      },
      getBalance: async () => {
        solReads += 1;
        return 2_000_000_000;
      },
    };
    try {
      const read = await readFaucetBalances(wallet, connection as never);
      assert.equal(read.usdc, 4);
      assert.equal(read.usdcOk, true);
      assert.equal(read.sol, 2);
      assert.equal(read.solOk, true);
      assert.equal(tokenReads, 1);
      assert.equal(solReads, 1);
    } finally {
      if (prevMint === undefined) delete process.env.NEXT_PUBLIC_USDC_MINT;
      else process.env.NEXT_PUBLIC_USDC_MINT = prevMint;
    }
  });

  test("new faucet copy exists in Polish and English, and the card title matches the header", () => {
    assert.equal(FAUCET_POST_TIMEOUT_MS, 150_000);
    assert.equal(FAUCET_CONFIRM_POLL_MS, 3_000);
    assert.equal(FAUCET_CONFIRM_MAX_MS, 120_000);
    assert.equal(translate("pl", "faucet.unconfirmed"), UNCONFIRMED_PL);
    assert.equal(translate("en", "faucet.unconfirmed"), UNCONFIRMED_EN);
    assert.equal(translate("pl", "faucet.confirming"), "Czekam na potwierdzenie…");
    assert.equal(translate("en", "faucet.confirming"), "Waiting for confirmation…");
    assert.equal(translate("pl", "faucet.arrived"), "Środki dotarły.");
    assert.equal(translate("en", "faucet.arrived"), "Funds arrived.");

    const api = readFileSync(new URL("../lib/dca-api.ts", import.meta.url), "utf8");
    const claim = api.slice(api.indexOf("export async function claimFaucetUsdc"));
    assert.match(claim, /FAUCET_POST_TIMEOUT_MS/);
    assert.match(api, /fetchOwnerUsdcBalance/);
    assert.match(api, /fetchSolBalance/);
    assert.doesNotMatch(claim, /90_000/);

    const layout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
    assert.match(layout, /title: "PreStocks·DCA"/);
    assert.doesNotMatch(layout, /title: "PreStocks DCA · noir 3\.0"/);

    const overview = readFileSync(
      new URL("../components/OverviewView.tsx", import.meta.url),
      "utf8",
    );
    const fn = overview.slice(
      overview.indexOf("async function onClaimFaucet"),
      overview.indexOf("const weeklyRev"),
    );
    const catchBody = fn.slice(fn.indexOf("} catch"));
    assert.match(catchBody, /await predca\.refresh\(\)/);
    assert.match(fn, /setFaucetConfirming\(true\)/);
    assert.match(fn, /faucet\.arrived/);
    assert.match(overview, /t\("faucet\.confirming"\)/);
    assert.match(overview, /faucetBusy \|\| faucetConfirming/);
  });
});
