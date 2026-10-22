import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("allocation toggles positions and the price panel above the last purchase", () => {
  const overview = readFileSync(
    new URL("../components/OverviewView.tsx", import.meta.url),
    "utf8",
  );
  assert.equal(overview.split("<PricesPanel").length - 1, 1);
  const holdings = overview.indexOf('t("holdings.titleOnChain")');
  const detailsBtn = overview.indexOf('t("pnl.details")');
  const pnl = overview.indexOf("<PnlSection");
  const positions = overview.indexOf("<PositionsCard");
  const panel = overview.indexOf("<PricesPanel");
  const lastPurchase = overview.lastIndexOf('t("lastPurchase.');
  assert.ok(holdings > 0 && holdings < detailsBtn && detailsBtn < pnl);
  assert.ok(pnl < positions && positions < panel && panel < lastPurchase);
  assert.match(
    overview,
    /const showPnl = connected && predca\.positions\.length > 0;/,
  );
  assert.match(
    overview,
    /const \[detailsOpen, setDetailsOpen\] = useState\(false\);/,
  );
  assert.match(
    overview,
    /\{showPnl && detailsOpen && \(\s*<PositionsCard[\s\S]*?\/>\s*\)\}\s*\{showPnl && detailsOpen && \(\s*<PricesPanel/,
  );
  const pnlFn = overview.slice(
    overview.indexOf("function PnlSection"),
    overview.indexOf("function PositionsCard"),
  );
  assert.doesNotMatch(pnlFn, /pnl\.details/);
  assert.doesNotMatch(pnlFn, /aria-expanded/);
  const allocation = overview.slice(holdings, pnl);
  assert.match(allocation, /aria-expanded=\{detailsOpen\}/);
  assert.match(
    allocation,
    /detailsOpen \? t\("pnl\.hideDetails"\) : t\("pnl\.details"\)/,
  );
  assert.match(overview, /^      <div className="grid gap-4 lg:grid-cols-2/m);
});
