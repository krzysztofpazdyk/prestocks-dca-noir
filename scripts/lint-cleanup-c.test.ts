import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement, useEffect, useLayoutEffect, useRef } from "react";
import { renderToString } from "react-dom/server";
import {
  connectionSettled,
  pickerShouldClose,
  pickerShouldOpenForError,
  settleDepsChanged,
  type SettleSnapshot,
} from "../lib/connect-picker";
import {
  commitLatestRef,
  useIsomorphicLayoutEffect,
} from "../lib/hooks/useLatestRef";

const bridge = readFileSync(
  new URL("../components/PrivyWalletBridge.tsx", import.meta.url),
  "utf8",
);
const settings = readFileSync(
  new URL("../components/SettingsView.tsx", import.meta.url),
  "utf8",
);
const auto = readFileSync(
  new URL("../lib/hooks/useAutoWeeklyBuy.tsx", import.meta.url),
  "utf8",
);
const connect = readFileSync(
  new URL("../components/ConnectWalletButton.tsx", import.meta.url),
  "utf8",
);
const latestHook = readFileSync(
  new URL("../lib/hooks/useLatestRef.ts", import.meta.url),
  "utf8",
);

function assertLayoutBeforeEffect(src: string, start: string): void {
  const body = src.slice(src.indexOf(start));
  const layoutAt = body.indexOf("useIsomorphicLayoutEffect(");
  const passiveAt = body.indexOf("useEffect(");
  assert.ok(layoutAt > 0 && passiveAt > layoutAt, start);
}

test("latest ref copies in the layout phase, not during render", () => {
  assert.equal(typeof window, "undefined");
  assert.equal(useIsomorphicLayoutEffect, useEffect);
  assert.notEqual(useIsomorphicLayoutEffect, useLayoutEffect);
  assert.match(
    latestHook,
    /typeof window !== "undefined" \? useLayoutEffect : useEffect/,
  );
  const effectAt = latestHook.indexOf("useIsomorphicLayoutEffect(() => {");
  const commitAt = latestHook.indexOf("commitLatestRef(ref, value)");
  assert.ok(effectAt > 0 && commitAt > effectAt);
  assert.equal(
    latestHook.slice(0, effectAt).includes("commitLatestRef(ref, value)"),
    false,
  );

  const ref = { current: "first" };
  const seen: string[] = [];
  seen.push(ref.current);
  commitLatestRef(ref, "second");
  seen.push(ref.current);
  assert.deepEqual(seen, ["first", "second"]);
});

test("latest ref renders on the server without a layout effect warning", () => {
  function Probe() {
    const ref = useRef("value");
    useIsomorphicLayoutEffect(() => {
      commitLatestRef(ref, "value");
    });
    return createElement("span", null, ref.current);
  }
  const warnings: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    const html = renderToString(createElement(Probe));
    assert.match(html, />value</);
    assert.equal(warnings.join("\n").includes("useLayoutEffect"), false);
  } finally {
    console.error = orig;
  }
});

test("wallet refs are no longer assigned in the component body", () => {
  assert.doesNotMatch(bridge, /\.current\s*=/);
  assert.equal((bridge.match(/commitLatestRef\(/g) ?? []).length, 5);
  assertLayoutBeforeEffect(bridge, "export function PrivyWalletBridge");
  assert.ok(
    bridge.indexOf("commitLatestRef(embeddedRef, embedded)") <
      bridge.indexOf("embeddedRef.current"),
  );
  assert.ok(
    bridge.indexOf("commitLatestRef(standardRef, standardWallets)") <
      bridge.indexOf("standardRef.current"),
  );

  assert.match(settings, /commitLatestRef\(signMessageRef, signMessage\)/);
  assert.doesNotMatch(settings, /signMessageRef\.current\s*=/);
  assert.ok(
    settings.indexOf("commitLatestRef(signMessageRef, signMessage)") <
      settings.indexOf("signMessageRef.current"),
  );
  assertLayoutBeforeEffect(settings, "export function SettingsView");

  for (const gone of [
    "predcaRef.current = predca",
    "connectedRef.current = connected",
    "ownerRef.current =",
    "signMessageRef.current = signMessage",
    "enabledRef.current = enabled",
    "tRef.current = t",
    "localeRef.current = locale",
    "nextAtRef.current = nextAt",
  ]) {
    assert.equal(auto.includes(gone), false, gone);
  }
  assert.equal((auto.match(/commitLatestRef\(/g) ?? []).length, 8);
  assertLayoutBeforeEffect(auto, "function useAutoWeeklyBuyImpl");
});

test("wallet switch still clears the banner and invalidates in-flight work", () => {
  const effectAt = auto.indexOf("const prev = prevOwnerRef.current;");
  const statusAt = auto.indexOf("keeperStatus(ownerKey, sign ?? undefined)");
  assert.ok(effectAt > 0 && statusAt > effectAt);
  const effect = auto.slice(effectAt, auto.indexOf("useEffect(() => {", effectAt));
  assert.match(effect, /const ownerChanged = prev !== ownerKey/);
  assert.match(effect, /statusEpochRef\.current \+= 1/);
  assert.match(effect, /clearStatusAuthCache\(prev\)/);
  assert.match(effect, /clearStatusAuthCache\(\)/);
  assert.match(effect, /cycleInFlight = false/);
  assert.match(effect, /ignoreOffUntilRef\.current = Date\.now\(\) \+ 2000/);
  assert.match(
    effect,
    /if \(ownerChanged\) \{\s*resetBannerState\(\);\s*setPrefsReady\(false\);\s*setKeeperMode\(null\);\s*\}/,
  );
});

function snap(patch: Partial<SettleSnapshot> = {}): SettleSnapshot {
  return {
    busy: false,
    dropped: false,
    staleHold: false,
    connected: true,
    hasPublicKey: true,
    pinnedAddress: null,
    error: null,
    publicKey: "key-a",
    ...patch,
  };
}

test("picker opens for a new error and closes only when the settled snapshot changes", () => {
  assert.equal(pickerShouldOpenForError(null, null), false);
  assert.equal(pickerShouldOpenForError("rejected", null), true);
  assert.equal(pickerShouldOpenForError("rejected", "rejected"), false);
  assert.equal(pickerShouldOpenForError("timeout", "rejected"), true);
  assert.equal(pickerShouldOpenForError(null, "rejected"), false);

  const settled = snap();
  assert.equal(connectionSettled(settled), true);
  assert.equal(pickerShouldClose(settled, false), false);
  assert.equal(pickerShouldClose(settled, true), true);
  assert.equal(settleDepsChanged(null, settled), true);
  assert.equal(settleDepsChanged(settled, settled), false);
  assert.equal(
    settleDepsChanged(settled, snap({ publicKey: "key-b" })),
    true,
  );
  assert.equal(pickerShouldClose(snap({ busy: true }), true), false);
  assert.equal(pickerShouldClose(snap({ error: "rejected" }), true), false);
  assert.equal(pickerShouldClose(snap({ dropped: true }), true), false);
  assert.equal(pickerShouldClose(snap({ staleHold: true }), true), false);
  assert.equal(
    pickerShouldClose(
      snap({ connected: false, hasPublicKey: false, publicKey: null }),
      true,
    ),
    false,
  );
  assert.equal(
    pickerShouldClose(
      snap({
        connected: false,
        hasPublicKey: false,
        publicKey: null,
        pinnedAddress: "Ab12",
      }),
      true,
    ),
    true,
  );

  assert.match(connect, /pickerShouldOpenForError\(job\.error, seenErrorRef\.current\)/);
  assert.match(connect, /pickerShouldClose\(next, settleDepsChanged\(seenSettleRef\.current, next\)\)/);
  assert.match(connect, /if \(job\.busy && !busyWas\.current\) setPickerOpen\(true\)/);
});
