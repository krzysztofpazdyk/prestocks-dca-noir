import assert from "node:assert/strict";
import test from "node:test";
import { friendlyAutoBuyError } from "../lib/auto-buy-error";
import {
  SignatureNotConfirmedError,
  confirmSignatureByPolling,
} from "../lib/buy-ata";
import { formatCount, translate } from "../lib/i18n";
import {
  formatDollars,
  formatGrouped,
  setNumberLocaleForTests,
} from "../lib/number-format";
import { formatUsd } from "../lib/predca";
import { renderPurchaseNotice } from "../lib/purchase-notice";
import {
  purchaseMsgClass,
  purchaseMsgTone,
} from "../lib/purchase-msg-tone";
import { isVaultLowReason } from "../lib/vault-low-reason";

const SIG = "3".repeat(88);

test("purchase color follows the tone, and the word check only overrides ok", () => {
  const expiredPl =
    "Transakcja nie dotarła do sieci (blockhash wygasł) — możesz spróbować ponownie.";
  const expiredEn =
    "The transaction did not reach the network (blockhash expired) — you can try again.";
  const lowPl = "Za mało USDC w vault (on-chain): $1,00 < $12,00.";
  const lowEn = "Not enough USDC in the vault (on-chain): $1.00 < $12.00.";
  const pending = "Zakup wysłany, Devnet jeszcze nie potwierdził.";

  assert.equal(purchaseMsgTone("fail", expiredPl), "fail");
  assert.equal(purchaseMsgTone("fail", expiredEn), "fail");
  assert.equal(purchaseMsgTone("fail", lowPl), "fail");
  assert.equal(purchaseMsgTone("fail", lowEn), "fail");
  assert.equal(purchaseMsgTone("ok", expiredPl), "ok");
  assert.equal(purchaseMsgTone("ok", lowEn), "ok");
  assert.equal(purchaseMsgTone("pending", `${pending} failed`), "pending");
  assert.equal(purchaseMsgTone("ok", "Zakup nieudany — szczegóły"), "fail");
  assert.equal(purchaseMsgTone("ok", "Purchase failed — see details"), "fail");
  assert.equal(purchaseMsgTone("ok", "Could not update the budget"), "fail");
  assert.equal(purchaseMsgTone("ok", "Nie udało się zaktualizować budżetu"), "fail");
  assert.equal(purchaseMsgTone("ok", "Zakup on-chain OK"), "ok");

  assert.match(purchaseMsgClass("pending"), /text-\[#fbbf24\]/);
  assert.match(purchaseMsgClass("fail"), /text-\[#fca5a5\]/);
  assert.match(purchaseMsgClass("ok"), /text-\[#2dd4bf\]/);
});

test("one 500 while confirming still accepts a later confirmed status", async () => {
  let reads = 0;
  await confirmSignatureByPolling(
    async () => {
      reads += 1;
      if (reads === 1) {
        throw Object.assign(new Error("500 Internal error"), { status: 500 });
      }
      return [{ err: null, confirmationStatus: "confirmed" }];
    },
    SIG,
    { sleep: async () => {}, now: () => 0, statusTimeoutMs: 20 },
  );
  assert.equal(reads, 2);
});

test("Internal error on every status read ends as SignatureNotConfirmedError", async () => {
  let now = 0;
  let reads = 0;
  await assert.rejects(
    () =>
      confirmSignatureByPolling(
        async () => {
          reads += 1;
          throw new Error("JSON-RPC Internal error");
        },
        SIG,
        {
          timeoutMs: 40,
          intervalMs: 20,
          statusTimeoutMs: 15,
          now: () => now,
          sleep: async (ms) => {
            now += ms;
          },
        },
      ),
    (err: unknown) => {
      assert.equal(err instanceof SignatureNotConfirmedError, true);
      if (!(err instanceof SignatureNotConfirmedError)) return false;
      assert.equal(err.signature, SIG);
      assert.match(err.message, new RegExp(SIG));
      return true;
    },
  );
  assert.equal(reads, 3);
  assert.equal(now, 40);
});

test("a status read that never returns throws within the limit", { timeout: 2000 }, async () => {
  let now = 0;
  const started = Date.now();
  await assert.rejects(
    () =>
      confirmSignatureByPolling(
        () => new Promise(() => {}),
        SIG,
        {
          timeoutMs: 45,
          intervalMs: 20,
          statusTimeoutMs: 15,
          now: () => now,
          sleep: async (ms) => {
            now += ms;
          },
        },
      ),
    (err: unknown) => {
      assert.equal(err instanceof SignatureNotConfirmedError, true);
      if (!(err instanceof SignatureNotConfirmedError)) return false;
      assert.equal(err.signature, SIG);
      return true;
    },
  );
  assert.ok(Date.now() - started < 1000);
  assert.equal(now, 45);
});

test("Signature rejected with a space is a rejected auto-buy", () => {
  assert.equal(
    friendlyAutoBuyError("Signature rejected: invalid signature", "en"),
    translate("en", "auto.error.rejected"),
  );
  assert.equal(
    friendlyAutoBuyError("Signature rejected: invalid signature", "pl"),
    translate("pl", "auto.error.rejected"),
  );
  assert.equal(
    friendlyAutoBuyError("Podpis odrzucony: nieprawidłowy podpis", "pl"),
    translate("pl", "auto.error.rejected"),
  );
  assert.equal(translate("pl", "auto.error.rejected"), "Odrzucono prośbę w portfelu.");
  assert.equal(
    translate("en", "auto.error.rejected"),
    "The wallet rejected the request.",
  );
});

test("vault-low detection matches the real phrases only", () => {
  for (const reason of [
    "vault_low",
    "insufficient vault",
    "InsufficientVault",
    "za mało USDC",
    "Za mało USDC w vault",
    "not enough USDC",
    "Not enough USDC in the vault",
    "Error Number: 6002",
    "custom program error: 0x1772",
    "Niewystarczające saldo w vault.",
    "Not enough balance in the vault.",
  ]) {
    assert.equal(isVaultLowReason(reason), true, reason);
  }
  for (const reason of [
    "not enough SOL",
    "USDC mint mismatch",
    "vault PDA error",
    "network timeout",
  ]) {
    assert.equal(isVaultLowReason(reason), false, reason);
  }
});

test("the same browser writes the same digits in Polish and English", () => {
  assert.equal(formatCount("pl", 12.5), formatCount("en", 12.5));
  assert.equal(formatDollars(1234.5), "$1,234.50");
  assert.equal(formatUsd(1234.5), "$1,234.50");
  setNumberLocaleForTests("pl-PL");
  try {
    assert.equal(formatCount("pl", 1234.5, { min: 2, max: 2 }), formatCount("en", 1234.5, { min: 2, max: 2 }));
    assert.equal(formatDollars(1234.5), "$1234,50");
    assert.equal(formatDollars(12345.5), "$12\u00a0345,50");
    assert.equal(formatGrouped(12345.5, { min: 2, max: 2 }), "12\u00a0345,50");
    assert.equal(formatUsd(12.3), "$12,30");
  } finally {
    setNumberLocaleForTests(null);
  }
  setNumberLocaleForTests("en-US");
  try {
    assert.equal(formatDollars(1234.5), "$1,234.50");
    assert.equal(formatCount("pl", 1234.5, { min: 2, max: 2 }), "1,234.50");
    assert.equal(formatCount("en", 1234.5, { min: 2, max: 2 }), "1,234.50");
  } finally {
    setNumberLocaleForTests(null);
  }
});

test("a purchase notice is translated again when the language changes", () => {
  const pl = (key: string, vars?: Record<string, string | number>) =>
    translate("pl", key, vars);
  const en = (key: string, vars?: Record<string, string | number>) =>
    translate("en", key, vars);

  const noRecs = { key: "msg.noRecs" };
  assert.equal(renderPurchaseNotice(noRecs, pl), "Brak rekomendacji do zakupu.");
  assert.equal(renderPurchaseNotice(noRecs, en), "No recommendations to purchase.");

  const low = {
    key: "msg.vaultLowOnChain",
    vars: { have: "$1,00", need: "$12,00" },
  };
  assert.equal(
    renderPurchaseNotice(low, pl),
    "Za mało USDC w vault (on-chain): $1,00 < $12,00.",
  );
  assert.equal(
    renderPurchaseNotice(low, en),
    "Not enough USDC in vault (on-chain): $1,00 < $12,00.",
  );

  const ok = {
    key: "msg.purchaseOk",
    vars: { sig: "abcd1234", amount: "12.30", tokens: "OpenAI" },
    withPreview: true as const,
  };
  assert.equal(
    renderPurchaseNotice(ok, pl, "≈ 1 OpenAI po $2.00"),
    "Zakup on-chain OK · sig abcd1234… · $12.30 z vault → OpenAI ≈ 1 OpenAI po $2.00",
  );
  assert.equal(
    renderPurchaseNotice(ok, en, "≈ 1 OpenAI at $2.00"),
    "On-chain purchase OK · sig abcd1234… · $12.30 from vault → OpenAI ≈ 1 OpenAI at $2.00",
  );
  assert.equal(renderPurchaseNotice(ok, en, null).includes("≈"), false);

  const fail = { key: "msg.budgetSyncFail", detail: "wallet said no" };
  assert.equal(
    renderPurchaseNotice(fail, pl),
    "Nie udało się zaktualizować budżetu on-chain przed zakupem.: wallet said no",
  );
  assert.equal(
    renderPurchaseNotice(fail, en),
    "Could not update on-chain budget before purchase.: wallet said no",
  );
});
