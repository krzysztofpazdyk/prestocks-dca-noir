import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { looksLikeRawAutoBuyError, presentAutoBuyError } from "../lib/auto-buy-error";
import { translate } from "../lib/i18n";
import {
  PRIVY_BLOCKHASH_EXPIRED_KEY,
  PRIVY_SIGN_SUCCESS_DESCRIPTION_KEY,
  PRIVY_SIGN_SUCCESS_HEADER_KEY,
  PRIVY_SIGN_WAIT_KEY,
  beginPrivySign,
  endPrivySign,
  getPrivySigningSnapshot,
  privySendFailureMessage,
  privySignSuccessUi,
  subscribePrivySigning,
} from "../lib/privy-sign-ui";

const STALE = new Error(
  "Transaction simulation failed: Blockhash not found",
);

test("Privy success copy follows the language and keeps the Approve screen", () => {
  const pl = privySignSuccessUi("pl");
  const en = privySignSuccessUi("en");
  assert.deepEqual(Object.keys(pl).sort(), [
    "successDescription",
    "successHeader",
  ]);
  assert.equal("showWalletUIs" in pl, false);
  assert.equal("showWalletUIs" in en, false);

  assert.equal(pl.successHeader, "Podpisano. Kliknij Close, aby wysłać.");
  assert.equal(
    pl.successDescription,
    "To jeszcze nie jest wysłanie. Środki nie zostały ruszone.",
  );
  assert.doesNotMatch(pl.successDescription, /Zamknij/);
  assert.match(pl.successDescription, /nie jest wysłanie/);
  assert.match(pl.successDescription, /Środki nie zostały ruszone/);
  assert.equal(en.successHeader, "Signed. Click Close to send.");
  assert.match(en.successDescription, /has not been sent/);
  assert.match(en.successDescription, /No funds have moved/);

  assert.notEqual(pl.successHeader, "Transaction signed!");
  assert.notEqual(en.successHeader, "Transaction signed!");
  assert.doesNotMatch(pl.successDescription, /You're all set/);
  assert.doesNotMatch(en.successDescription, /You're all set/);
  assert.notEqual(pl.successHeader, en.successHeader);

  for (const locale of ["pl", "en"] as const) {
    for (const key of [
      PRIVY_SIGN_SUCCESS_HEADER_KEY,
      PRIVY_SIGN_SUCCESS_DESCRIPTION_KEY,
      PRIVY_SIGN_WAIT_KEY,
      PRIVY_BLOCKHASH_EXPIRED_KEY,
    ]) {
      const text = translate(locale, key);
      assert.notEqual(text, key);
      assert.equal(looksLikeRawAutoBuyError(text), false, `${locale} ${key}`);
      assert.equal(presentAutoBuyError(text, locale).text, text);
    }
  }
  assert.equal(
    translate("pl", PRIVY_SIGN_WAIT_KEY),
    "Zatwierdź i zamknij okno Privy, żeby wysłać transakcję",
  );
  assert.equal(
    translate("en", PRIVY_SIGN_WAIT_KEY),
    "Approve and close the Privy window to send the transaction",
  );
});

test("a stale blockhash on Privy explains that nothing was sent", () => {
  const pl = privySendFailureMessage(STALE, "pl", true);
  const en = privySendFailureMessage(STALE, "en", true);
  assert.equal(
    pl,
    "Transakcja nie została wysłana. Środki nie zostały ruszone. Spróbuj ponownie i szybciej zamknij okno Privy.",
  );
  assert.equal(
    en,
    "The transaction was not sent. No funds moved. Try again and close the Privy window sooner.",
  );
  assert.match(pl ?? "", /nie została wysłana/);
  assert.match(pl ?? "", /nie zostały ruszone/);
  assert.match(en ?? "", /was not sent/);
  assert.match(en ?? "", /No funds moved/);

  const fromLogs = privySendFailureMessage(
    { message: "Simulation failed", logs: ["Blockhash not found"] },
    "en",
    true,
  );
  assert.equal(fromLogs, en);

  assert.equal(
    privySendFailureMessage(new Error("Transaction expired"), "pl", true),
    pl,
  );
  assert.equal(privySendFailureMessage(STALE, "pl", false), null);
  assert.equal(
    privySendFailureMessage(new Error("insufficient funds"), "en", true),
    null,
  );
  assert.equal(
    privySendFailureMessage(
      new Error("TransactionExpiredBlockheightExceededError: block height exceeded"),
      "en",
      true,
    ),
    null,
  );
});

test("the signing flag stays up until the last Privy prompt finishes", () => {
  for (let i = 0; i < 5 && getPrivySigningSnapshot(); i += 1) endPrivySign();
  assert.equal(getPrivySigningSnapshot(), false);
  const seen: boolean[] = [];
  const stop = subscribePrivySigning(() => {
    seen.push(getPrivySigningSnapshot());
  });
  beginPrivySign();
  beginPrivySign();
  assert.equal(getPrivySigningSnapshot(), true);
  endPrivySign();
  assert.equal(getPrivySigningSnapshot(), true);
  endPrivySign();
  assert.equal(getPrivySigningSnapshot(), false);
  endPrivySign();
  assert.equal(getPrivySigningSnapshot(), false);
  assert.deepEqual(seen, [true, false]);
  stop();
});

test("the bridge customizes the success screen and still asks before signing", () => {
  const bridge = readFileSync(
    new URL("../components/PrivyWalletBridge.tsx", import.meta.url),
    "utf8",
  );
  const signAt = bridge.indexOf("signTransactionBytes:");
  const signFn = bridge.slice(
    signAt,
    bridge.indexOf("return () => setPrivyWalletDelegate(null)"),
  );
  assert.ok(signAt > 0);
  assert.match(signFn, /privySignSuccessUi\(getLocaleSnapshot\(\)\)/);
  assert.equal(/showWalletUIs\s*:/.test(signFn), false);
  assert.ok(signFn.indexOf("beginPrivySign()") < signFn.indexOf("try {"));
  assert.ok(
    signFn.indexOf("finally") > 0 &&
      signFn.indexOf("finally") < signFn.indexOf("endPrivySign()"),
  );
  assert.equal(/showWalletUIs\s*:/.test(bridge), false);

  const hook = readFileSync(
    new URL("../lib/hooks/usePredca.ts", import.meta.url),
    "utf8",
  );
  assert.match(hook, /withOneStaleBlockhashRetry\(isPrivy,/);
  assert.match(
    hook,
    /privySendFailureMessage\(e, getLocaleSnapshot\(\), isPrivy\)/,
  );
});
