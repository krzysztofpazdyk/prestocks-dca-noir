import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { newestRunRecord, runsNewestFirst } from "../lib/run-order";

test("the overview card and the top of history are the same newest run", () => {
  const runs = [
    { runIndex: 1, ts: 300, name: "old" },
    { runIndex: 4, ts: 100, name: "newest-index-older-ts" },
    { runIndex: 3, ts: 900, name: "high-ts" },
    { runIndex: 4, ts: 250, name: "same-index-newer-ts" },
    { runIndex: 0, ts: 9999, name: "first" },
  ];
  const card = newestRunRecord(runs);
  const history = runsNewestFirst(runs);
  assert.equal(card, history[0]);
  assert.equal(card?.name, "same-index-newer-ts");
  assert.deepEqual(
    history.map((run) => run.name),
    [
      "same-index-newer-ts",
      "newest-index-older-ts",
      "high-ts",
      "old",
      "first",
    ],
  );
  assert.equal(newestRunRecord([]), null);
  assert.deepEqual(runsNewestFirst([]), []);
});

test("a BN runIndex still picks the highest index, then ts", () => {
  const runs = [
    { runIndex: { toNumber: () => 2 }, ts: { toNumber: () => 50 }, id: "second" },
    { runIndex: { toNumber: () => 9 }, ts: { toNumber: () => 1 }, id: "ninth" },
    { runIndex: { toNumber: () => 9 }, ts: { toNumber: () => 8 }, id: "ninth-later" },
    { runIndex: { toNumber: () => 0 }, ts: { toNumber: () => 99 }, id: "zero" },
  ];
  const card = newestRunRecord(runs);
  assert.equal(card?.id, "ninth-later");
  assert.equal(runsNewestFirst(runs)[0], card);
});

test("history uses the newest-run order and overview does not render it", () => {
  const hook = readFileSync(new URL("../lib/hooks/usePredca.ts", import.meta.url), "utf8");
  const history = readFileSync(
    new URL("../components/HistoryView.tsx", import.meta.url),
    "utf8",
  );
  const overview = readFileSync(
    new URL("../components/OverviewView.tsx", import.meta.url),
    "utf8",
  );
  assert.match(hook, /const lastRun = newestRunRecord\(runs\)/);
  assert.match(history, /runsNewestFirst\(predca\.runs\)/);
  assert.equal(history.includes(".reverse()"), false);
  assert.equal(overview.includes("predca.lastRun"), false);
  assert.equal(overview.includes("lastPurchase"), false);
});
