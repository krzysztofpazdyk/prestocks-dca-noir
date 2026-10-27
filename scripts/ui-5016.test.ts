import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { allocationShareText, allocationTooltipText } from "../lib/allocation-label";
import { shouldAttemptPrivyRestore } from "../lib/connect-wallet";
import { withFaucetButtonCap } from "../lib/dca-api";
import { fmtSignedPnl } from "../lib/format-usd";
import { historyEntriesLine, historyEntryForm } from "../lib/history-view";
import { translate } from "../lib/i18n";
import { formatDollars, setNumberLocaleForTests } from "../lib/number-format";
import {
  pnlSummary,
  portfolioProfitPct,
  profitPercentOnDeposits,
  strategyDepositUsd,
  type PositionRow,
} from "../lib/position-value";

const historySrc = readFileSync(
  new URL("../components/HistoryView.tsx", import.meta.url),
  "utf8",
);
const overviewSrc = readFileSync(
  new URL("../components/OverviewView.tsx", import.meta.url),
  "utf8",
);
const pieSrc = readFileSync(
  new URL("../components/HoldingsPie.tsx", import.meta.url),
  "utf8",
);
const buttonSrc = readFileSync(
  new URL("../components/ConnectWalletButton.tsx", import.meta.url),
  "utf8",
);
const apiSrc = readFileSync(new URL("../lib/dca-api.ts", import.meta.url), "utf8");

function row(partial: Partial<PositionRow> & Pick<PositionRow, "name">): PositionRow {
  return {
    units: 1,
    costUsd: 0,
    pricedUnits: 1,
    legacyCostUsd: 0,
    priceNow: 1,
    valueUsd: 0,
    pnlUsd: null,
    pnlPct: null,
    avgBuyPrice: null,
    basis: "market",
    stale: false,
    mismatch: false,
    ...partial,
  };
}

test("history header stays History and the subtitle is the record count", () => {
  assert.equal(translate("en", "history.kicker"), "Purchases (auto & manual)");
  assert.equal(translate("pl", "history.kicker"), "Purchases (auto & manual)");
  assert.equal(translate("en", "history.title"), "History");
  assert.equal(translate("pl", "history.title"), "Historia");
  assert.equal(translate("pl", "history.onChainIntro"), "history.onChainIntro");
  assert.equal(translate("en", "history.onChainIntro"), "history.onChainIntro");

  assert.equal(historyEntryForm(1, "pl"), "one");
  assert.equal(historyEntryForm(2, "pl"), "few");
  assert.equal(historyEntryForm(4, "pl"), "few");
  assert.equal(historyEntryForm(5, "pl"), "many");
  assert.equal(historyEntryForm(12, "pl"), "many");
  assert.equal(historyEntryForm(14, "pl"), "many");
  assert.equal(historyEntryForm(21, "pl"), "many");
  assert.equal(historyEntryForm(22, "pl"), "few");
  assert.equal(historyEntryForm(24, "pl"), "few");
  assert.equal(historyEntryForm(0, "pl"), "many");
  assert.equal(historyEntryForm(1, "en"), "one");
  assert.equal(historyEntryForm(5, "en"), "many");
  assert.equal(historyEntryForm(22, "en"), "many");

  assert.equal(historyEntriesLine(1, "pl"), "1 wpis");
  assert.equal(historyEntriesLine(2, "pl"), "2 wpisy");
  assert.equal(historyEntriesLine(4, "pl"), "4 wpisy");
  assert.equal(historyEntriesLine(5, "pl"), "5 wpisów");
  assert.equal(historyEntriesLine(12, "pl"), "12 wpisów");
  assert.equal(historyEntriesLine(14, "pl"), "14 wpisów");
  assert.equal(historyEntriesLine(21, "pl"), "21 wpisów");
  assert.equal(historyEntriesLine(22, "pl"), "22 wpisy");
  assert.equal(historyEntriesLine(0, "en"), "0 entries");
  assert.equal(historyEntriesLine(1, "en"), "1 entry");
  assert.equal(historyEntriesLine(12, "en"), "12 entries");
  for (const line of [historyEntriesLine(12, "pl"), historyEntriesLine(12, "en")]) {
    assert.equal(line.includes("RunRecord"), false);
    assert.equal(line.includes("on-chain"), false);
  }

  assert.match(historySrc, /historyEntriesLine\(predca\.runs\.length, locale\)/);
  assert.match(historySrc, /<h1 className="mt-1 text-xl font-semibold">\{t\("history\.title"\)\}<\/h1>/);
  assert.doesNotMatch(historySrc, /history\.onChainIntro/);
  assert.doesNotMatch(historySrc, /RunRecord on-chain/);
});

test("Overview does not render the last purchase card", () => {
  assert.equal(overviewSrc.includes("lastPurchase"), false);
  assert.equal(overviewSrc.includes("Ostatni zakup"), false);
  assert.doesNotMatch(overviewSrc, /HistoryRunEntry/);
  assert.match(overviewSrc, /v\{APP_VERSION\}/);
});

test("portfolio value uses two decimal places like the neighbouring amounts", () => {
  setNumberLocaleForTests("pl-PL");
  try {
    assert.equal(formatDollars(1509, 2), "$1509,00");
    assert.equal(formatDollars(500, 2), "$500,00");
    assert.equal(formatDollars(9.28, 2), "$9,28");
  } finally {
    setNumberLocaleForTests(null);
  }
  assert.match(overviewSrc, /fmtMoney\(displayPortfolioUsd\)/);
  assert.doesNotMatch(overviewSrc, /fmtMoney\(displayPortfolioUsd,\s*0\)/);
});

test("portfolio profit percent uses every deposit still in the strategy", () => {
  const expected = (9.28 / 1500) * 100;
  const pct = profitPercentOnDeposits(9.28, [1000, 500]);
  assert.ok(pct != null);
  assert.ok(Math.abs(pct - expected) < 1e-9);
  assert.ok(Math.abs(pct - 0.618666) < 0.01);

  const spent = [{ costUsd: 1000 }];
  assert.equal(strategyDepositUsd(500, spent), 1500);
  const before = portfolioProfitPct(9.28, 0, spent);
  const after = portfolioProfitPct(9.28, 500, spent);
  assert.ok(before != null && after != null);
  assert.ok(Math.abs(before - (9.28 / 1000) * 100) < 1e-9);
  assert.ok(Math.abs(after - expected) < 1e-9);
  assert.ok(after < before);
  assert.equal(portfolioProfitPct(9.28, null, spent), null);

  const oldCost = 9.28 / 0.015;
  const vault = 1509 - 9.28 - oldCost;
  const oldSummary = pnlSummary([
    row({ name: "SpaceX", costUsd: oldCost, pnlUsd: 9.28, valueUsd: oldCost + 9.28 }),
  ]);
  assert.ok(oldSummary.pnlPct != null);
  assert.ok(Math.abs(oldSummary.pnlPct - 1.5) < 1e-9);
  const fixed = portfolioProfitPct(9.28, vault, [{ costUsd: oldCost }]);
  assert.ok(fixed != null);
  assert.ok(Math.abs(fixed - (9.28 / (1509 - 9.28)) * 100) < 1e-6);
  assert.ok(fixed < 1);

  setNumberLocaleForTests("pl-PL");
  try {
    const shown = fmtSignedPnl(9.28, after, "pl");
    assert.equal(shown, "+$9,28 (+0,6%)");
  } finally {
    setNumberLocaleForTests(null);
  }

  const pnlFn = overviewSrc.slice(
    overviewSrc.indexOf("function PnlSection"),
    overviewSrc.indexOf("function PositionsCard"),
  );
  assert.match(pnlFn, /portfolioProfitPct\(pnl, vaultUsdc, rows\)/);
  assert.doesNotMatch(pnlFn, /summary\.pnlPct/);
  assert.match(overviewSrc, /vaultUsdc=\{predca\.vaultUsdc\}/);
});

test("allocation hover uses the same share text as the legend", () => {
  assert.equal(allocationShareText(33.2), "33.2%");
  assert.equal(allocationTooltipText("SpaceX", 33.2), "SpaceX 33.2%");
  assert.match(pieSrc, /allocationTooltipText\(name, share\)/);
  assert.match(pieSrc, /allocationShareText\(h\.value\)/);
  assert.match(pieSrc, />100%</);
  assert.match(pieSrc, /content=\{AllocationTooltip\}/);
  assert.match(pieSrc, /background:\s*"var\(--background\)"/);
  assert.match(pieSrc, /color:\s*"var\(--foreground\)"/);
  assert.match(pieSrc, /border:\s*"none"/);
  assert.match(pieSrc, /boxShadow:\s*"none"/);
  assert.doesNotMatch(pieSrc, /contentStyle=\{/);
  assert.equal(pieSrc.includes("#141820"), false);
  assert.equal(pieSrc.includes("1px solid"), false);
});

test("the SOL tile keeps its title and drops the unit beside the number", () => {
  const tile = overviewSrc.slice(
    overviewSrc.indexOf('t("tile.sol")'),
    overviewSrc.indexOf('t("tile.usdcWallet")'),
  );
  assert.match(tile, /fmtTile\(displaySol, 4\)/);
  assert.match(tile, /unit: ""/);
  assert.equal(tile.includes('"SOL"'), false);
  assert.equal(translate("pl", "tile.sol"), "SOL");
  assert.equal(translate("en", "tile.sol"), "SOL");
});

test("Privy reload waits until the embedded adapter has an account", () => {
  const ready = {
    storedName: "Privy",
    ready: true,
    authenticated: true,
    hasEmbeddedWallet: true,
    adapterListed: true,
    adapterHasAccount: true,
    alreadyAttempted: false,
  };
  assert.equal(shouldAttemptPrivyRestore(ready), true);
  assert.equal(shouldAttemptPrivyRestore({ ...ready, adapterHasAccount: false }), false);
  assert.equal(shouldAttemptPrivyRestore({ ...ready, adapterListed: false }), false);
  assert.equal(shouldAttemptPrivyRestore({ ...ready, alreadyAttempted: true }), false);
  assert.equal(shouldAttemptPrivyRestore({ ...ready, storedName: "Phantom" }), false);
  assert.equal(shouldAttemptPrivyRestore({ ...ready, authenticated: false }), false);
  assert.match(buttonSrc, /shouldAttemptPrivyRestore/);
  assert.match(buttonSrc, /adapterHasAccount\(listed\?\.adapter\)/);
});

test("a hung faucet claim returns the button with the unconfirmed error", async () => {
  let fire: (() => void) | null = null;
  const pending = withFaucetButtonCap(new Promise(() => {}), 50, {
    setTimer: (fn) => {
      fire = fn;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {},
  });
  assert.ok(fire);
  const started = fire as () => void;
  const caught = pending.then(
    () => null,
    (err: unknown) => err,
  );
  started();
  const err = await caught;
  assert.ok(err instanceof Error);
  assert.equal(err.message, translate("pl", "faucet.unconfirmed"));

  let cleared = 0;
  const value = await withFaucetButtonCap(Promise.resolve({ ok: true }), 60_000, {
    setTimer: () => 7 as unknown as ReturnType<typeof setTimeout>,
    clearTimer: () => {
      cleared += 1;
    },
  });
  assert.deepEqual(value, { ok: true });
  assert.equal(cleared, 1);

  const claim = apiSrc.slice(apiSrc.indexOf("if (FAUCET_GATEWAY_STATUSES.has(resp.status))"));
  const confirming = claim.indexOf("options.onConfirming?.()");
  const cancel = claim.indexOf("await cancelFaucetBody(resp)");
  assert.ok(confirming >= 0 && cancel > confirming);
  const fn = overviewSrc.slice(
    overviewSrc.indexOf("async function onClaimFaucet"),
    overviewSrc.indexOf("const weeklyRev"),
  );
  assert.match(fn, /withFaucetButtonCap\(/);
  assert.match(fn, /setFaucetConfirming\(true\)/);
  assert.match(fn, /setFaucetBusy\(false\)/);
  const catchBody = fn.slice(fn.indexOf("} catch"));
  assert.match(catchBody, /setFaucetBusy\(false\)/);
  assert.match(catchBody, /setFaucetConfirming\(false\)/);
  assert.match(catchBody, /setFaucetErr\(/);
});
