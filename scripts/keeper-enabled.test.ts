import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  keeperEnabledForConnectedOwner,
  keeperStatusNeedsSignature,
  nextAutoBuyEnabled,
} from "../lib/keeper-enabled";

const OWNER = "ownerA";

test("session_required is unknown, never off", () => {
  assert.equal(
    keeperEnabledForConnectedOwner({ ok: false, error: "session_required" }, OWNER),
    null,
  );
  assert.equal(
    keeperEnabledForConnectedOwner(
      { ok: false, error: "session_required", enabled: false, owner: OWNER },
      OWNER,
    ),
    null,
  );
  assert.equal(keeperStatusNeedsSignature({ error: "session_required" }), true);
  assert.equal(keeperStatusNeedsSignature({ error: "keeper_unreachable" }), false);
  assert.equal(keeperStatusNeedsSignature({ error: "sign_rejected: closed" }), true);
  assert.equal(keeperStatusNeedsSignature({ error: "public_status_unavailable" }), false);
  assert.equal(
    keeperEnabledForConnectedOwner(
      { ok: false, error: "public_status_unavailable", enabled: false, owner: OWNER },
      OWNER,
    ),
    null,
  );
  assert.equal(
    keeperEnabledForConnectedOwner(
      { ok: false, error: "keeper_unreachable" },
      OWNER,
    ),
    null,
  );
  assert.equal(
    nextAutoBuyEnabled(
      null,
      { ok: false, error: "public_status_unavailable" },
      OWNER,
    ),
    null,
  );
  assert.equal(
    nextAutoBuyEnabled(null, { ok: false, error: "keeper_unreachable" }, OWNER),
    null,
  );
});

test("a real off from this owner stays off", () => {
  assert.equal(
    keeperEnabledForConnectedOwner(
      { ok: true, enabled: false, owner: OWNER },
      OWNER,
    ),
    false,
  );
  assert.equal(
    keeperEnabledForConnectedOwner(
      { ok: true, enabled: true, owner: OWNER },
      OWNER,
    ),
    true,
  );
});

test("enable stays on across a transitional status; disable stays off", () => {
  let action: boolean | null = true;
  const transitional = [
    { ok: true, enabled: false, owner: OWNER },
    { ok: true, owner: OWNER },
    { ok: true, enabled: false, owner: OWNER, phase: "enabling" },
    { ok: true, enabled: false, owner: OWNER, phase: "buying" },
    { ok: true, enabled: false, owner: OWNER, phase: "checking" },
    { ok: true, enabled: false, owner: OWNER, phase: "ranking" },
    { ok: true, enabled: false, owner: OWNER, phase: "confirming" },
    { ok: true, enabled: false, owner: OWNER, phase: "pending" },
    { enabled: false },
    {},
  ];
  for (const st of transitional) {
    const next = nextAutoBuyEnabled(action, st, OWNER);
    assert.equal(next, true, JSON.stringify(st));
    action = next;
  }
  action = false;
  for (const st of transitional) {
    const next = nextAutoBuyEnabled(action, st, OWNER);
    assert.equal(next, false, JSON.stringify(st));
    action = next;
  }
  assert.equal(
    nextAutoBuyEnabled(
      true,
      { ok: true, enabled: false, owner: OWNER, phase: "off" },
      OWNER,
    ),
    false,
  );
  assert.equal(nextAutoBuyEnabled(null, { ok: true, owner: OWNER }, OWNER), null);
  assert.equal(
    nextAutoBuyEnabled(null, { ok: true, enabled: false, owner: OWNER }, OWNER),
    false,
  );
});

test("the enable action commits the switch before a silent status can clear it", () => {
  const hook = readFileSync(
    new URL("../lib/hooks/useAutoWeeklyBuy.tsx", import.meta.url),
    "utf8",
  );
  const post = hook.indexOf("await keeperEnable(");
  assert.ok(post > 0);
  const before = hook.slice(post - 700, post);
  assert.match(before, /actionEnabledRef\.current = true/);
  assert.match(before, /setEnabledState\(true\)/);
  assert.match(hook, /nextAutoBuyEnabled\(actionEnabledRef\.current, st, wallet\)/);
  assert.match(hook, /nextAutoBuyEnabled\(actionEnabledRef\.current, st, ownerKey\)/);
  const settings = readFileSync(
    new URL("../components/SettingsView.tsx", import.meta.url),
    "utf8",
  );
  assert.match(settings, /checked=\{autoBuy\.enabled\}/);
});
