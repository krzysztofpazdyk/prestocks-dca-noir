import assert from "node:assert/strict";
import test from "node:test";
import {
  keeperEnabledForConnectedOwner,
  keeperStatusNeedsSignature,
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
