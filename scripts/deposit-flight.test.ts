import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { translate } from "../lib/i18n";
import {
  clearDepositFlight,
  DEPOSIT_FLIGHT_KEY,
  readDepositFlight,
  takeInterruptedDeposit,
  writeDepositFlight,
  type DepositStorage,
} from "../lib/deposit-flight";

function mem(): DepositStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

test("a reload drops the deposit flight and does not keep it", () => {
  const storage = mem();
  assert.equal(takeInterruptedDeposit(storage, 1_000), null);
  writeDepositFlight(storage, { amountUsd: 25, startedAtMs: 1_000 });
  assert.equal(storage.data.has(DEPOSIT_FLIGHT_KEY), true);
  const flight = takeInterruptedDeposit(storage, 2_000);
  assert.deepEqual(flight, { amountUsd: 25, startedAtMs: 1_000 });
  assert.equal(readDepositFlight(storage, 3_000), null);
  assert.equal(takeInterruptedDeposit(storage, 3_000), null);
});

test("a corrupt flight is cleared and does not hang", () => {
  const storage = mem();
  storage.setItem(DEPOSIT_FLIGHT_KEY, "{");
  assert.equal(takeInterruptedDeposit(storage, 1), null);
  assert.equal(storage.data.has(DEPOSIT_FLIGHT_KEY), false);
  storage.setItem(DEPOSIT_FLIGHT_KEY, JSON.stringify({ amountUsd: 0, startedAtMs: 1 }));
  assert.equal(readDepositFlight(storage, 1), null);
  clearDepositFlight(storage);
});

test("Deposit shows sending feedback and clears a flight left by reload", () => {
  assert.equal(translate("pl", "deposit.sending"), "Wysyłam wpłatę…");
  assert.equal(translate("en", "deposit.sending"), "Sending deposit…");
  assert.match(translate("pl", "deposit.interrupted"), /Odświeżenie przerwało/);
  assert.match(translate("en", "deposit.interrupted"), /Reload interrupted/);

  const overview = readFileSync(
    new URL("../components/OverviewView.tsx", import.meta.url),
    "utf8",
  );
  assert.match(overview, /writeDepositFlight\(/);
  assert.match(overview, /takeInterruptedDeposit\(/);
  assert.match(overview, /clearDepositFlight\(/);
  assert.match(overview, /t\("deposit\.sending"\)/);
  assert.match(overview, /t\("deposit\.interrupted"\)/);
  assert.match(overview, /depositDisabled \|\| depositSending/);
  const fn = overview.slice(
    overview.indexOf("async function submitDeposit"),
    overview.indexOf("async function submitWithdraw"),
  );
  assert.match(fn, /setDepositNote\(t\("deposit\.sending"\)\)/);
  assert.match(fn, /setDepositSending\(false\)/);
});
