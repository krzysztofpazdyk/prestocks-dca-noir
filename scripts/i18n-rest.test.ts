import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { translate, shown } from "../lib/i18n";
import {
  getLocaleSnapshot,
  writeStoredLocale,
} from "../lib/locale-store";
import { BUY_ALREADY_IN_FLIGHT_MSG } from "../lib/manual-buy-guard";
import { FAILED_EXPIRED_MSG, UNRESOLVED_MSG } from "../lib/pending-tx";
import {
  RUN_INDEX_TAKEN_MSG,
  isRunIndexTakenMessage,
  parseAnchorError,
} from "../lib/predca";
import { isOnChainSignatureReject } from "../lib/vault-follow-up";
import { isVaultLowReason } from "../lib/vault-low-reason";

const NEW_KEYS = [
  "tx.priorSession",
  "tx.kind.budget",
  "tx.sessionCheck",
  "tx.err.connectWallet",
  "tx.err.noUsdcMint",
  "tx.err.depositPositive",
  "tx.err.firstDepositBudget",
  "tx.err.predcaNotInit",
  "tx.err.withdrawPositive",
  "tx.err.budgetPositive",
  "tx.err.missingMints",
  "tx.err.needThreeMints",
  "tx.err.noFreeRunIndex",
  "tx.err.buyInFlight",
  "tx.err.invalidAmount",
  "tx.err.unknown",
  "tx.err.walletRejected",
  "tx.err.rpcDown",
  "tx.err.insufficientMock",
  "tx.err.missingAta",
  "tx.err.lowWalletUsdc",
  "tx.vaultLag",
  "tx.sigUnconfirmed",
  "tx.unconfirmedTimeout",
  "tx.confirmStillPending",
  "tx.failedExpired",
  "tx.unresolved",
  "predca.rpcReadError",
  "msg.vaultLow",
  "privy.missingWallet",
  "privy.noSignedTx",
  "privy.noSignatureBytes",
  "privy.notReadyToSign",
  "privy.signNotReady",
  "privy.boundary.title",
  "privy.boundary.body",
  "privy.boundary.retry",
  "auto.signRejected",
  "auto.needSignMessage",
  "auto.weeklySaveFailed",
  "rank.source.metricsNoJev",
  "rank.source.cacheByok",
  "rank.source.cacheNoByok",
  "rank.source.grokJev",
  "rank.source.jev",
  "rank.source.dryNoByok",
  "rank.source.sample",
  "rank.source.metricsJevDown",
  "rank.source.waiting",
  "rank.source.noByok",
  "rank.err.hostedUnreachable",
  "rank.err.noDryApi",
  "rank.err.noRankProxy",
  "rank.err.noFaucet",
  "rank.err.faucetNotJson",
  "rank.err.hostedDown",
  "rank.err.noApiNoProxy",
  "rank.err.byokRequired",
  "jev.proxyHint",
  "jev.proxyDown",
  "jev.noProxy",
  "jev.badKey",
  "jev.noTypesafeKey",
  "jev.unavailable",
  "prestocks.skippedDirect",
  "prestocks.corsProxy",
  "prestocks.sessionFallback",
  "prestocks.snapshotError",
];

function dictKeys(which: "pl" | "en"): string[] {
  const src = readFileSync(new URL("../lib/i18n.tsx", import.meta.url), "utf8");
  const start = src.indexOf(which === "pl" ? "const pl: Dict" : "const en: Dict");
  const end = src.indexOf(which === "pl" ? "const en: Dict" : "const dictionaries");
  return [...src.slice(start, end).matchAll(/^\s*"([^"]+)":/gm)].map((hit) => hit[1]);
}

function installLocalStorage(): { restore: () => void } {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => (data.has(key) ? data.get(key)! : null),
    setItem: (key: string, value: string) => {
      data.set(key, String(value));
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    clear: () => data.clear(),
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  } as Storage;
  const prev = globalThis.localStorage;
  globalThis.localStorage = storage;
  return {
    restore() {
      if (prev === undefined) {
        delete (globalThis as { localStorage?: Storage }).localStorage;
      } else {
        globalThis.localStorage = prev;
      }
    },
  };
}

test("new message keys exist in Polish and English and are not empty", () => {
  const plKeys = new Set(dictKeys("pl"));
  const enKeys = new Set(dictKeys("en"));
  for (const key of NEW_KEYS) {
    assert.equal(plKeys.has(key), true, key);
    assert.equal(enKeys.has(key), true, key);
    const pl = translate("pl", key);
    const en = translate("en", key);
    assert.ok(pl.trim().length > 0, key);
    assert.ok(en.trim().length > 0, key);
    assert.notEqual(pl, key, key);
    assert.notEqual(en, key, key);
  }
});

test("Polish sentences stay word for word, including vault, prior session, and program codes", () => {
  assert.equal(
    translate("pl", "msg.vaultLow"),
    "Za mało USDC w vault: {have} < {need}.",
  );
  assert.equal(
    translate("pl", "msg.vaultLowOnChain"),
    "Za mało USDC w vault (on-chain): {have} < {need}.",
  );
  assert.equal(
    translate("pl", "tx.priorSession"),
    "Transakcja z poprzedniej sesji weszła: {kind} {tail}",
  );
  assert.equal(
    translate("pl", "auto.error.predca.6004"),
    "Indeks RunRecord zajęty. Spróbuj ponownie.",
  );
  assert.equal(
    translate("pl", "auto.error.predca.6009"),
    "Brak ceny dla tokena — keeper jeszcze jej nie ustawił.",
  );
  assert.equal(
    translate("pl", "auto.error.predca.6010"),
    "Cena tokena jest nieaktualna. Keeper odświeża ceny co kilka minut — spróbuj za chwilę.",
  );
  assert.equal(RUN_INDEX_TAKEN_MSG, translate("pl", "auto.error.predca.6004"));
  assert.equal(BUY_ALREADY_IN_FLIGHT_MSG, "Zakup już w toku.");
  assert.equal(translate("en", "auto.weeklySaveFailed").includes("Could not"), true);
  assert.equal(translate("en", "rank.source.grokJev").includes("Grok+Jev"), true);
  assert.equal(translate("pl", "rank.source.grokJev").includes("Grok+Jev"), true);
});

test("purchase tone, vault-low, rejection, and a taken run index match Polish, English, and old text", () => {
  const toneSrcFile = readFileSync(
    new URL("../lib/purchase-msg-tone.ts", import.meta.url),
    "utf8",
  );
  const toneSrc = toneSrcFile.match(/\/(nieudany\|failed\|Could not\|Nie udało)\/i/);
  assert.ok(toneSrc);
  const tone = new RegExp(toneSrc[1], "i");
  assert.match(translate("pl", "msg.purchaseFail"), tone);
  assert.match(translate("en", "msg.purchaseFail"), tone);
  assert.match("Nie udało się wykonać zakupu.", tone);
  assert.doesNotMatch(translate("pl", "tx.ok.deposit", { amount: "5" }), tone);

  const hook = readFileSync(
    new URL("../lib/hooks/useAutoWeeklyBuy.tsx", import.meta.url),
    "utf8",
  );
  assert.equal((hook.match(/isVaultLowReason\(/g) ?? []).length, 2);
  assert.equal(isVaultLowReason("Za mało USDC w vault: 1 < 2."), true);
  assert.equal(isVaultLowReason("Not enough USDC in the vault: 1 < 2."), true);
  assert.equal(isVaultLowReason("vault_low"), true);
  assert.equal(isVaultLowReason("network timeout"), false);

  const oldReject = new Error("Transakcja odrzucona przez Devnet. SIG");
  const enReject = new Error(translate("en", "tx.err.rejected", { signature: "SIG" }));
  assert.equal(isOnChainSignatureReject(oldReject), true);
  assert.equal(isOnChainSignatureReject(enReject), true);
  assert.equal(
    isOnChainSignatureReject(new Error(translate("pl", "tx.err.walletRejected"))),
    false,
  );
  assert.equal(
    isOnChainSignatureReject(new Error(translate("en", "tx.err.walletRejected"))),
    false,
  );
  assert.equal(
    isOnChainSignatureReject(new Error(translate("pl", "tx.confirmStillPending"))),
    false,
  );

  const oldTaken = "Indeks RunRecord zajęty. Spróbuj ponownie.";
  assert.equal(isRunIndexTakenMessage(oldTaken), true);
  assert.equal(isRunIndexTakenMessage(RUN_INDEX_TAKEN_MSG), true);
  assert.equal(
    isRunIndexTakenMessage(translate("en", "auto.error.predca.6004")),
    true,
  );
  assert.equal(isRunIndexTakenMessage("Indeks RunRecord zajęty"), false);
});

test("a stored sentence is shown in the language active when it is read", () => {
  const box = installLocalStorage();
  try {
    writeStoredLocale("pl");
    assert.equal(getLocaleSnapshot(), "pl");
    assert.equal(String(FAILED_EXPIRED_MSG), translate("pl", "tx.failedExpired"));
    assert.equal(String(UNRESOLVED_MSG), translate("pl", "tx.unresolved"));
    assert.equal(
      parseAnchorError(new Error(RUN_INDEX_TAKEN_MSG)),
      RUN_INDEX_TAKEN_MSG,
    );
    assert.equal(shown("tx.err.buyInFlight"), BUY_ALREADY_IN_FLIGHT_MSG);

    writeStoredLocale("en");
    assert.equal(String(FAILED_EXPIRED_MSG), translate("en", "tx.failedExpired"));
    assert.equal(String(UNRESOLVED_MSG), translate("en", "tx.unresolved"));
    assert.equal(
      parseAnchorError(new Error("Indeks RunRecord zajęty. Spróbuj ponownie.")),
      translate("en", "auto.error.predca.6004"),
    );
    assert.equal(
      shown("tx.priorSession", { kind: "deposit", tail: "1 USDC" }),
      "Transaction from the previous session landed: deposit 1 USDC",
    );
    assert.equal(
      shown("msg.vaultLow", { have: "1.00", need: "2.00" }),
      "Not enough USDC in the vault: 1.00 < 2.00.",
    );
  } finally {
    writeStoredLocale("pl");
    box.restore();
  }
});
