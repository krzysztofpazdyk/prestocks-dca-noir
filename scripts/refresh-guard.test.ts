import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CRITICAL_REFRESH_SOURCES,
  refreshCallDecision,
} from "../lib/predca-refresh";

test("poll skips only while a refresh is in flight", () => {
  assert.equal(refreshCallDecision({ source: "poll", inFlight: true }), "skip");
  assert.equal(refreshCallDecision({ source: "poll", inFlight: false }), "run");
});

test("every critical source runs even while a refresh is in flight", () => {
  for (const source of CRITICAL_REFRESH_SOURCES) {
    assert.equal(refreshCallDecision({ source, inFlight: true }), "run", source);
    assert.equal(refreshCallDecision({ source, inFlight: false }), "run", source);
  }
  for (const source of ["owner", "disconnect", "keeper", "afterTx", "manual"] as const) {
    assert.equal(refreshCallDecision({ source, inFlight: true }), "run", source);
  }
});

test("omitted source defaults to critical and still runs while in flight", () => {
  assert.equal(refreshCallDecision({ inFlight: true }), "run");
  assert.equal(refreshCallDecision({ inFlight: false }), "run");
  assert.equal(refreshCallDecision({ source: undefined, inFlight: true }), "run");
});

test("other non-critical sources skip while a refresh is in flight", () => {
  assert.equal(refreshCallDecision({ source: "background", inFlight: true }), "skip");
  assert.equal(refreshCallDecision({ source: "background", inFlight: false }), "run");
});

test("nested post-tx reads are not skipped while a refresh is in flight", () => {
  assert.equal(
    refreshCallDecision({ source: "poll", inFlight: true, nested: true }),
    "run",
  );
  assert.equal(
    refreshCallDecision({ source: "critical", inFlight: true, nested: true }),
    "run",
  );
});

test("polling passes source poll; mount, keeper, and actions stay critical", () => {
  const hook = readFileSync(new URL("../lib/hooks/usePredca.ts", import.meta.url), "utf8");
  const refreshAt = hook.indexOf("const refresh = useCallback");
  const refreshFn = hook.slice(refreshAt, hook.indexOf("void refresh()"));
  assert.match(refreshFn, /refreshCallDecision\(/);
  assert.match(refreshFn, /opts\?\.source \?\? "critical"/);
  assert.match(refreshFn, /source\?: "poll" \| "critical"/);
  assert.equal(refreshFn.includes("if (!nested && refreshInFlightRef.current) return null"), false);

  const genBump = refreshFn.indexOf("++flightGen.current");
  const noOwner = refreshFn.indexOf("if (!owner)");
  assert.ok(genBump > 0 && noOwner > genBump);
  const disconnect = refreshFn.slice(noOwner, noOwner + 500);
  assert.match(disconnect, /EMPTY_SNAPSHOT/);
  assert.match(disconnect, /prices: new Map\(\)/);
  assert.match(disconnect, /mayPublish\(\)/);

  const fin = refreshFn.slice(refreshFn.lastIndexOf("finally"));
  assert.match(fin, /if \(!nested && flightGen\.current === myGen\)/);
  const releaseAt = fin.indexOf("refreshInFlightRef.current = false");
  const loadingOff = fin.indexOf("setLoading(false)");
  assert.ok(releaseAt > 0 && loadingOff > releaseAt);
  assert.match(fin.slice(loadingOff - 40, loadingOff), /if \(!still\(\)\) return;/);

  const mountAt = hook.indexOf("void refresh();");
  assert.ok(mountAt > refreshAt);
  assert.equal(hook.slice(mountAt, hook.indexOf("\n", mountAt)).includes("poll"), false);

  const pollAt = hook.indexOf("visibilitychange");
  const pollStart = hook.lastIndexOf("useEffect", pollAt);
  const pollEnd = hook.indexOf("const refreshPrices", pollStart);
  const poll = hook.slice(pollStart, pollEnd);
  assert.match(poll, /chainPollDecision\(/);
  assert.match(poll, /source:\s*"poll"/);
  assert.match(poll, /quiet:\s*true/);
  assert.equal(poll.includes("signMessage"), false);

  const afterPoll = hook.slice(pollEnd);
  for (const hit of afterPoll.matchAll(/\brefresh\(([^)]*)\)/g)) {
    assert.equal(hit[1].includes('"poll"'), false, hit[0]);
  }

  const afterTx = hook.slice(hook.indexOf("async function refreshAfterTx"));
  const publishGuard = afterTx.indexOf("flightGen.current !== myGen");
  const clearFlag = afterTx.indexOf("refreshInFlightRef.current = false");
  assert.ok(publishGuard > 0 && clearFlag > publishGuard);
  assert.match(afterTx.slice(afterTx.indexOf("finally")), /flightGen\.current === myGen/);

  const auto = readFileSync(
    new URL("../lib/hooks/useAutoWeeklyBuy.tsx", import.meta.url),
    "utf8",
  );
  const keeperCalls = [...auto.matchAll(/predcaRef\.current\.refresh\(([^)]*)\)/g)];
  assert.ok(keeperCalls.length >= 3);
  for (const hit of keeperCalls) {
    assert.equal(hit[1].includes("poll"), false, hit[0]);
  }

  const overview = readFileSync(
    new URL("../components/OverviewView.tsx", import.meta.url),
    "utf8",
  );
  const actionCalls = [...overview.matchAll(/predca\.refresh\(([^)]*)\)/g)];
  assert.ok(actionCalls.length >= 2);
  for (const hit of actionCalls) {
    assert.equal(hit[1].includes("poll"), false, hit[0]);
  }
});
