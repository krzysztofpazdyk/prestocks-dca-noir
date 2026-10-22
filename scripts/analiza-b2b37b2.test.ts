import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ACCOUNT_LOOKUP_RETRY_MS,
  SignatureFailedError,
  SignatureNotConfirmedError,
  confirmSignatureByPolling,
  reasonFromAnchorLogs,
  signatureFailedError,
  withOneNetworkRetry,
} from "../lib/buy-ata";
import { formatCount, translate } from "../lib/i18n";
import { noteUnconfirmedRunIndex } from "../lib/manual-buy-guard";
import { resolveVaultBalanceForBuy } from "../lib/predca";
import { isStaleBlockhashError } from "../lib/privy-blockhash";
import { isOnChainSignatureReject, isUnconfirmedTimeout } from "../lib/vault-follow-up";

const SIG = "2".repeat(88);

function rateLimit(): Error {
  return Object.assign(new Error("HTTP 429 Too Many Requests"), { status: 429 });
}

const VAULT_LOGS = [
  "Program log: Instruction: SimulateBuyV2",
  "Program log: AnchorError thrown in programs/predca/src/lib.rs:10. Error Code: InsufficientVault. Error Number: 6002. Error Message: Insufficient vault balance.",
];

test("a single 429 while polling still confirms the signature", async () => {
  let reads = 0;
  await confirmSignatureByPolling(
    async () => {
      reads += 1;
      if (reads === 1) throw rateLimit();
      return [{ err: null, confirmationStatus: "confirmed" }];
    },
    SIG,
    { sleep: async () => {}, now: () => 0 },
  );
  assert.equal(reads, 2);
});

test("status reads that keep failing become an unconfirmed signature", async () => {
  let now = 0;
  let sleeps = 0;
  let reads = 0;
  await assert.rejects(
    () =>
      confirmSignatureByPolling(
        async () => {
          reads += 1;
          throw rateLimit();
        },
        SIG,
        {
          timeoutMs: 3000,
          intervalMs: 1500,
          now: () => now,
          sleep: async (ms) => {
            sleeps += 1;
            now += ms;
          },
        },
      ),
    (err: unknown) => {
      assert.equal(err instanceof SignatureNotConfirmedError, true);
      assert.equal(err instanceof SignatureFailedError, false);
      const pending = isUnconfirmedTimeout(err);
      assert.deepEqual(pending, { signature: SIG });
      assert.equal(isOnChainSignatureReject(err), false);
      assert.equal(isStaleBlockhashError(err), false);
      const created = new Set<number>();
      noteUnconfirmedRunIndex(created, 4, err);
      assert.equal(created.has(4), true);
      return true;
    },
  );
  assert.equal(reads, 3);
  assert.equal(sleeps, 2);
  assert.equal(now, 3000);
});

test("any status-read error stays pending until the limit", async () => {
  let now = 0;
  let reads = 0;
  let slept = 0;
  await assert.rejects(
    () =>
      confirmSignatureByPolling(
        async () => {
          reads += 1;
          throw new Error("Invalid account owner");
        },
        SIG,
        {
          timeoutMs: 3000,
          intervalMs: 1500,
          statusTimeoutMs: 20,
          now: () => now,
          sleep: async (ms) => {
            slept += 1;
            now += ms;
          },
        },
      ),
    (err: unknown) => {
      assert.equal(err instanceof SignatureNotConfirmedError, true);
      assert.equal(err instanceof SignatureFailedError, false);
      const pending = isUnconfirmedTimeout(err);
      assert.deepEqual(pending, { signature: SIG });
      const created = new Set<number>();
      noteUnconfirmedRunIndex(created, 4, err);
      assert.equal(created.has(4), true);
      return true;
    },
  );
  assert.equal(reads, 3);
  assert.equal(slept, 2);
  assert.equal(now, 3000);
});

test("a failed signature uses Anchor logs, and keeps the old text without them", async () => {
  const reason = reasonFromAnchorLogs(VAULT_LOGS);
  assert.equal(reason, "Niewystarczające saldo w vault.");
  assert.equal(reasonFromAnchorLogs([]), null);
  assert.equal(reasonFromAnchorLogs(["Program log: something else failed"]), null);

  let statusReads = 0;
  let logReads = 0;
  await assert.rejects(
    () =>
      confirmSignatureByPolling(
        async () => {
          statusReads += 1;
          return [{ err: { InstructionError: [0, { Custom: 6002 }] }, confirmationStatus: null }];
        },
        SIG,
        {
          now: () => 0,
          sleep: async () => {
            throw new Error("failed signature must not keep polling");
          },
          readLogs: async () => {
            logReads += 1;
            return VAULT_LOGS;
          },
        },
      ),
    (err: unknown) => {
      assert.equal(err instanceof SignatureFailedError, true);
      if (!(err instanceof SignatureFailedError)) return false;
      assert.equal(err.signature, SIG);
      assert.equal(err.onChainReject, true);
      assert.equal(err.message, `Niewystarczające saldo w vault. ${SIG}`);
      assert.equal(isOnChainSignatureReject(err), true);
      assert.equal(isUnconfirmedTimeout(err), null);
      assert.equal(isStaleBlockhashError(err), false);
      return true;
    },
  );
  assert.equal(statusReads, 1);
  assert.equal(logReads, 1);

  for (const readLogs of [
    async () => null,
    async () => [],
    async () => {
      throw rateLimit();
    },
  ]) {
    await assert.rejects(
      () =>
        confirmSignatureByPolling(
          async () => [{ err: { InstructionError: [0, "Custom"] }, confirmationStatus: null }],
          SIG,
          { now: () => 0, sleep: async () => {}, readLogs },
        ),
      (err: unknown) => {
        assert.equal(err instanceof SignatureFailedError, true);
        if (!(err instanceof SignatureFailedError)) return false;
        assert.equal(err.message, `Transakcja odrzucona przez Devnet. ${SIG}`);
        assert.equal(isOnChainSignatureReject(err), true);
        return true;
      },
    );
  }
});

test("rejection is recognized from the class and from the old Polish sentence", () => {
  const english = signatureFailedError(SIG, null, "en");
  assert.equal(english.message, `Transaction rejected by Devnet. ${SIG}`);
  assert.equal(isOnChainSignatureReject(english), true);
  assert.equal(isOnChainSignatureReject(new Error(`Transakcja odrzucona przez Devnet. ${SIG}`)), true);
  assert.equal(isOnChainSignatureReject(new Error(`Transaction rejected by Devnet. ${SIG}`)), true);
  assert.equal(isOnChainSignatureReject(new SignatureNotConfirmedError(SIG, 1000)), false);
});

test("transaction copy has the same keys in Polish and English", () => {
  const src = readFileSync(new URL("../lib/i18n.tsx", import.meta.url), "utf8");
  const pl = src.slice(src.indexOf("const pl: Dict"), src.indexOf("const en: Dict"));
  const en = src.slice(src.indexOf("const en: Dict"), src.indexOf("const dictionaries"));
  const keys = (block: string) => [...block.matchAll(/^\s*"([^"]+)":/gm)].map((hit) => hit[1]);
  const plKeys = keys(pl);
  const enKeys = keys(en);
  assert.deepEqual(plKeys, enKeys);
  const needed = [
    "tx.ok.initDeposit",
    "tx.ok.deposit",
    "tx.ok.withdraw",
    "tx.ok.budget",
    "tx.ok.buyConfirmed",
    "tx.ok.buyConfirmedShort",
    "tx.ok.simulateBuy",
    "tx.buyPreviewLeg",
    "tx.err.noBuyIx",
    "tx.err.rejected",
    "tx.err.rejectedShort",
  ];
  for (const key of needed) {
    const plText = translate("pl", key, {
      amount: "5",
      names: "A",
      preview: "",
      tokens: "1",
      name: "A",
      price: "1,00",
      signature: SIG,
    });
    const enText = translate("en", key, {
      amount: "5",
      names: "A",
      preview: "",
      tokens: "1",
      name: "A",
      price: "1.00",
      signature: SIG,
    });
    assert.notEqual(plText, key, key);
    assert.notEqual(enText, key, key);
    assert.notEqual(plText, enText, key);
  }
  assert.equal(
    translate("pl", "tx.ok.initDeposit", { amount: formatCount("pl", 5) }),
    "Zainicjalizowano Predca + wpłacono $5 do vault.",
  );
  assert.equal(
    translate("pl", "tx.ok.deposit", { amount: formatCount("pl", 5) }),
    "Wpłacono $5 do vault.",
  );
  assert.equal(
    translate("pl", "tx.ok.withdraw", { amount: formatCount("pl", 5) }),
    "Wypłacono $5 z vault.",
  );
  assert.equal(translate("pl", "tx.ok.budget"), "Zapisano budżet tygodniowy on-chain.");
  assert.equal(
    translate("pl", "tx.ok.buyConfirmed", { amount: formatCount("pl", 12.5, { min: 2, max: 2 }) }),
    "Zakup on-chain potwierdzony: $12.50 z vault.",
  );
  assert.equal(
    formatCount("pl", 12.5, { min: 2, max: 2 }),
    formatCount("en", 12.5, { min: 2, max: 2 }),
  );
  assert.equal(translate("pl", "tx.ok.buyConfirmedShort"), "Zakup on-chain potwierdzony.");
  assert.equal(translate("pl", "tx.err.noBuyIx"), "Brak instrukcji zakupu.");
  assert.equal(
    translate("pl", "tx.err.rejected", { signature: SIG }),
    `Transakcja odrzucona przez Devnet. ${SIG}`,
  );
  assert.equal(translate("pl", "tx.err.rejectedShort"), "Transakcja odrzucona przez Devnet.");
  assert.equal(formatCount("pl", 10.5, { min: 2, max: 2 }), "10.50");
  assert.equal(formatCount("en", 10.5, { min: 2, max: 2 }), "10.50");
  assert.equal(
    translate("pl", "tx.buyPreviewLeg", {
      tokens: formatCount("pl", 1.5, { max: 6 }),
      name: "OpenAI",
      price: formatCount("pl", 2, { min: 2, max: 2 }),
    }),
    "≈ 1.5 OpenAI po $2.00",
  );
  assert.equal(
    translate("en", "tx.buyPreviewLeg", {
      tokens: formatCount("en", 1.5, { max: 6 }),
      name: "OpenAI",
      price: formatCount("en", 2, { min: 2, max: 2 }),
    }),
    "≈ 1.5 OpenAI at $2.00",
  );
});

test("the pre-buy vault balance prefers one fresh read", () => {
  assert.equal(resolveVaultBalanceForBuy(12, 3, null), 12);
  assert.equal(resolveVaultBalanceForBuy(0, 9, null), 0);
  assert.equal(resolveVaultBalanceForBuy(null, 9, null), null);
  assert.equal(resolveVaultBalanceForBuy(null, 9, rateLimit()), 9);
  assert.equal(resolveVaultBalanceForBuy(null, 0, rateLimit()), 0);
  assert.throws(() => resolveVaultBalanceForBuy(null, null, rateLimit()));
  assert.throws(
    () => resolveVaultBalanceForBuy(null, 9, new Error("Invalid account owner")),
    /Invalid account owner/,
  );
});

test("a missing token-account lookup retries once on 429 and then gives up", async () => {
  let reads = 0;
  let slept = 0;
  const infos = await withOneNetworkRetry(
    async () => {
      reads += 1;
      if (reads === 1) throw rateLimit();
      return [null, { lamports: 1 }];
    },
    {
      sleep: async (ms) => {
        slept += 1;
        assert.equal(ms, ACCOUNT_LOOKUP_RETRY_MS);
      },
    },
  );
  assert.equal(reads, 2);
  assert.equal(slept, 1);
  assert.deepEqual(infos, [null, { lamports: 1 }]);

  let failedReads = 0;
  await assert.rejects(
    () =>
      withOneNetworkRetry(
        async () => {
          failedReads += 1;
          throw rateLimit();
        },
        { sleep: async () => {}, pauseMs: 0 },
      ),
    (err: unknown) => {
      assert.equal(err instanceof Error && /429/.test(err.message), true);
      return true;
    },
  );
  assert.equal(failedReads, 2);

  let otherReads = 0;
  await assert.rejects(
    () =>
      withOneNetworkRetry(async () => {
        otherReads += 1;
        throw new Error("Invalid account owner");
      }),
    /Invalid account owner/,
  );
  assert.equal(otherReads, 1);
});

test("the buy hook reads a fresh vault and does not resend a failed signature", () => {
  const hook = readFileSync(new URL("../lib/hooks/usePredca.ts", import.meta.url), "utf8");
  const buy = hook.slice(hook.indexOf("async function simulateBuy"), hook.indexOf("function clearToasts"));
  assert.match(buy, /fetchVaultBalance\(connection, owner\)/);
  assert.match(buy, /resolveVaultBalanceForBuy\(freshVault, vaultUsdc, vaultReadError\)/);
  assert.match(buy, /msg\.vaultLowOnChain/);
  assert.match(buy, /withOneNetworkRetry\(\(\) =>\s*connection\.getMultipleAccountsInfo\(atas\)/);
  assert.match(buy, /maxSupportedTransactionVersion: 0/);
  assert.match(buy, /commitment: "confirmed"/);
  assert.doesNotMatch(buy, /Zainicjalizowano Predca \+ wpłacono/);
  assert.doesNotMatch(buy, /Brak instrukcji zakupu/);
  assert.match(buy, /tx\.ok\.simulateBuy/);
  assert.match(buy, /tx\.err\.noBuyIx/);
  const send = buy.slice(buy.indexOf("const sendAndConfirm"), buy.indexOf("if (plan === \"combined\")"));
  assert.equal(send.split("sendTransaction(").length - 1, 1);
  assert.equal(send.split("confirmSignatureByPolling(").length - 1, 1);
});
