/**
 * noir 5.0.26 card mode. Offline. No RPC, no devnet, no mainnet.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { AnchorProvider, BN, BorshCoder, type Idl } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import idl from "../idl/predca.json";
import { APP_VERSION } from "../lib/app-version";
import {
  classifyDefer,
  isAccountUpdatingError,
  isRunIndexMismatch,
} from "../lib/account-mode";
import { ownerAtaAddress } from "../lib/buy-ata";
import {
  SIMULATE_BUY_V3_ACCOUNT_ORDER,
  ZERO_SIGNATURE_HASH,
  cardBuyConfirmed,
  retryCardBuy,
} from "../lib/card-buy";
import {
  accountFeeRefundSol,
  buildCloseInstructions,
  clearClosedOwnerState,
  closeAccountUi,
  closeSubmitPlan,
} from "../lib/close-account";
import {
  entryFromCard,
  historyToLotInputs,
  mergeHistory,
  type HistoryEntry,
} from "../lib/history-entry";
import {
  entriesFromLogs,
  entriesFromTransaction,
  entryFromBuyEvent,
  fetchHistoryEvents,
  historyRpcCost,
  type HistoryCacheStorage,
} from "../lib/history-events";
import { translate } from "../lib/i18n";
import { runLots } from "../lib/position-value";
import {
  MOCK_USDC_MINT,
  getProgram,
  mintAuthPda,
  parseAnchorError,
  priceFeedPda,
  programId,
  userConfigPda,
  vaultPda,
} from "../lib/predca";
import { buyRefreshSettled } from "../lib/predca-refresh";
import {
  entriesFromSnapshot,
  loadReceiptSnapshot,
  resetReceiptSnapshotForTests,
  sha256Hex,
  validateReceiptSnapshot,
} from "../lib/receipts-snapshot";
import {
  CARD_USER_CONFIG_LEN,
  LEGACY_USER_CONFIG_LEN,
  ORIGIN_MANUAL,
  USER_CONFIG_DISC,
  decodeUserConfig,
  nextCardRunIndex,
} from "../lib/user-config";
import { writeStoredLocale } from "../lib/locale-store";
import { LS_AUTO_WEEKLY_BUY, LS_WEEKLY_BUDGET, scopedLsKey } from "../lib/auto-weekly-buy";
import { historyCacheKey } from "../lib/history-events";

const ANTHROPIC = "3MFLVffGvwRVpo4iGvALruCwZmQQvSDuwyFqgiaknZ5V";
const coder = new BorshCoder(idl as Idl);

function writeU64(buf: Buffer, offset: number, value: bigint): void {
  buf.writeBigUInt64LE(value, offset);
}

function writeI64(buf: Buffer, offset: number, value: bigint): void {
  buf.writeBigInt64LE(value, offset);
}

function legacyBytes(owner: PublicKey): Buffer {
  const buf = Buffer.alloc(LEGACY_USER_CONFIG_LEN);
  USER_CONFIG_DISC.forEach((byte, index) => {
    buf[index] = byte;
  });
  owner.toBuffer().copy(buf, 8);
  writeU64(buf, 40, BigInt(15_000_000));
  buf[48] = 2;
  writeI64(buf, 49, BigInt(70));
  buf[57] = 3;
  buf[58] = 4;
  return buf;
}

function cardBytes(owner: PublicKey, lastIndex: bigint, hasLast: boolean): Buffer {
  const buf = Buffer.alloc(CARD_USER_CONFIG_LEN);
  legacyBytes(owner).copy(buf, 0, 0, LEGACY_USER_CONFIG_LEN);
  let off = LEGACY_USER_CONFIG_LEN;
  buf[off] = 1;
  off += 1;
  buf[off] = hasLast ? 1 : 0;
  off += 1;
  writeU64(buf, off, lastIndex);
  off += 8;
  writeI64(buf, off, BigInt(90));
  off += 8;
  writeU64(buf, off, BigInt(12));
  off += 8;
  const mints = [owner, owner, owner];
  for (const mint of mints) {
    mint.toBuffer().copy(buf, off);
    off += 32;
  }
  for (let i = 0; i < 3; i++) {
    writeU64(buf, off, BigInt(2_500_000));
    off += 8;
  }
  for (let i = 0; i < 3; i++) {
    writeU64(buf, off, BigInt(80_000_000));
    off += 8;
  }
  buf[off] = 6;
  buf[off + 1] = 6;
  buf[off + 2] = 6;
  off += 3;
  for (let i = 0; i < 3; i++) {
    writeI64(buf, off, BigInt(90));
    off += 8;
  }
  writeU64(buf, off, BigInt(50_000_000));
  off += 8;
  writeU64(buf, off, BigInt(100_000));
  off += 8;
  off += 32;
  buf[off] = ORIGIN_MANUAL;
  return buf;
}

test("user-config decodes 59 and 305 bytes and rejects any other size", () => {
  const owner = Keypair.generate().publicKey;
  const legacy = decodeUserConfig(legacyBytes(owner));
  assert.equal(legacy.size, 59);
  assert.equal(legacy.legacy, true);
  assert.equal(legacy.card, undefined);
  assert.equal(legacy.owner.toBase58(), owner.toBase58());
  assert.equal(legacy.weeklyBudgetUsdc.toString(), "15000000");
  assert.equal(legacy.bump, 3);
  assert.equal(legacy.vaultBump, 4);

  const card = decodeUserConfig(cardBytes(owner, BigInt(4), true));
  assert.equal(card.size, 305);
  assert.equal(card.legacy, false);
  assert.equal(card.card?.cardVersion, 1);
  assert.equal(card.card?.hasLastRun, true);
  assert.equal(card.card?.lastRunIndex.toString(), "4");
  assert.equal(card.card?.lastOrigin, 2);
  assert.equal(nextCardRunIndex(card.card!), 5);

  const fresh = decodeUserConfig(cardBytes(owner, BigInt(0), false));
  assert.equal(fresh.card?.hasLastRun, false);
  assert.equal(nextCardRunIndex(fresh.card!), 0);

  assert.throws(() => decodeUserConfig(Buffer.alloc(60)), /size 60/);
  const badVersion = cardBytes(owner, BigInt(1), true);
  badVersion[59] = 2;
  assert.throws(() => decodeUserConfig(badVersion), /card_version 2/);
});

test("card buy uses simulate_buy_v3 account order and the card index", async () => {
  const owner = Keypair.generate();
  const { Connection } = await import("@solana/web3.js");
  const rpc = new Connection("http://127.0.0.1:1", "confirmed");
  const wallet = {
    publicKey: owner.publicKey,
    signTransaction: async <T>(tx: T) => tx,
    signAllTransactions: async <T>(txs: T[]) => txs,
  };
  const provider = new AnchorProvider(rpc, wallet, { commitment: "confirmed" });
  const program = getProgram(provider);
  const mints = [0, 1, 2].map(() => Keypair.generate().publicKey);
  const usdc = new PublicKey(MOCK_USDC_MINT);

  for (const index of [0, 5]) {
    const ix = await program.methods
      .simulateBuyV3(new BN(index), mints, Array.from(ZERO_SIGNATURE_HASH))
      .accounts({
        usdcMint: usdc,
        mintA: mints[0],
        mintB: mints[1],
        mintC: mints[2],
        priceFeedA: priceFeedPda(mints[0])[0],
        priceFeedB: priceFeedPda(mints[1])[0],
        priceFeedC: priceFeedPda(mints[2])[0],
      })
      .instruction();
    const expected = [
      owner.publicKey,
      userConfigPda(owner.publicKey)[0],
      usdc,
      vaultPda(owner.publicKey)[0],
      mintAuthPda()[0],
      mints[0],
      mints[1],
      mints[2],
      ownerAtaAddress(owner.publicKey, mints[0]),
      ownerAtaAddress(owner.publicKey, mints[1]),
      ownerAtaAddress(owner.publicKey, mints[2]),
      priceFeedPda(mints[0])[0],
      priceFeedPda(mints[1])[0],
      priceFeedPda(mints[2])[0],
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
      SystemProgram.programId,
    ];
    assert.equal(ix.keys.length, SIMULATE_BUY_V3_ACCOUNT_ORDER.length);
    assert.equal(ix.keys.length, expected.length);
    for (let i = 0; i < expected.length; i++) {
      assert.equal(ix.keys[i].pubkey.toBase58(), expected[i].toBase58(), SIMULATE_BUY_V3_ACCOUNT_ORDER[i]);
    }
    assert.equal(
      ix.keys.some((key) => key.pubkey.equals(userConfigPda(owner.publicKey)[0]) && false),
      false,
    );
    const disc = Buffer.from([162, 19, 185, 19, 37, 139, 142, 119]);
    assert.equal(Buffer.from(ix.data.subarray(0, 8)).equals(disc), true);
    assert.equal(Buffer.from(ix.data).readBigUInt64LE(8), BigInt(index));
  }

  const hook = readFileSync(new URL("../lib/hooks/usePredca.ts", import.meta.url), "utf8");
  const v3 = hook.slice(hook.indexOf(".simulateBuyV3("), hook.indexOf(".simulateBuyV2("));
  assert.match(v3, /priceFeedC/);
  assert.doesNotMatch(v3, /runPrice|runRecord/);
  assert.match(hook, /retryCardBuy/);
  assert.match(hook, /\.simulateBuyV2\(/);
});

test("6019 retries once and 59-byte 6020, 6022, or 3003 is the updating state", async () => {
  const calls: number[] = [];
  let reads = 0;
  const sig = await retryCardBuy({
    firstIndex: 3,
    rereadIndex: async () => {
      reads += 1;
      return 4;
    },
    submit: async (index) => {
      calls.push(index);
      if (calls.length === 1) {
        throw Object.assign(new Error("Error Number: 6019"), {
          error: { errorCode: { number: 6019, code: "RunIndexMismatch" } },
        });
      }
      return "sig";
    },
    isMismatch: isRunIndexMismatch,
    mismatchMessage: translate("en", "tx.err.runIndexMoved"),
  });
  assert.equal(sig, "sig");
  assert.deepEqual(calls, [3, 4]);
  assert.equal(reads, 1);

  await assert.rejects(
    () =>
      retryCardBuy({
        firstIndex: 1,
        rereadIndex: async () => 2,
        submit: async () => {
          throw new Error("Error Number: 6019");
        },
        isMismatch: isRunIndexMismatch,
        mismatchMessage: "stopped",
      }),
    /stopped/,
  );

  assert.equal(isAccountUpdatingError(new Error("Error Number: 6020"), true), true);
  assert.equal(isAccountUpdatingError(new Error("Error Number: 6022"), true), true);
  assert.equal(isAccountUpdatingError(new Error("AccountDidNotDeserialize"), true), true);
  assert.equal(isAccountUpdatingError(new Error("Error Number: 3003"), true), true);
  assert.equal(isAccountUpdatingError(new Error("Error Number: 6020"), false), false);
  assert.equal(isAccountUpdatingError(new Error("Error Number: 6019"), true), false);

  writeStoredLocale("pl");
  const pl = translate("pl", "account.updating");
  const en = translate("en", "account.updating");
  assert.equal(
    pl,
    "Aktualizujemy Twoje konto. Wpłaty, wypłaty i zakupy wrócą za chwilę. Środki są bezpieczne.",
  );
  assert.equal(
    en,
    "We are updating your account. Deposits, withdrawals and buys will be back shortly. Your funds are safe.",
  );
  for (const text of [pl, en]) {
    assert.doesNotMatch(text, /keeper/i);
    assert.doesNotMatch(text, /\bSOL\b/);
  }
  assert.equal(parseAnchorError(new Error("Error Number: 6023")), translate("pl", "tx.err.vaultNotEmpty"));
});

function eventBody(name: string, fields: Record<string, unknown>): string {
  const body = coder.types.encode(name, fields);
  const event = idl.events.find((item) => item.name === name);
  if (!event) throw new Error(name);
  return Buffer.concat([Buffer.from(event.discriminator), Buffer.from(body)]).toString("base64");
}

function logsFor(program: PublicKey, data: string): string[] {
  return [
    `Program ${program.toBase58()} invoke [1]`,
    `Program data: ${data}`,
    `Program ${program.toBase58()} success`,
  ];
}

const zeroHash = Array.from({ length: 32 }, () => 0);

test("history parses the five buy events, origin, dedup, and cache", async () => {
  const owner = Keypair.generate().publicKey;
  const other = Keypair.generate().publicKey;
  const mints = [0, 1, 2].map(() => Keypair.generate().publicKey);
  const base = {
    owner,
    run_index: new BN(4),
    mints,
    amounts: [new BN(2_500_000), new BN(1), new BN(1)],
    signature_hash: zeroHash,
    slot: new BN(9),
    ts: new BN(90),
  };
  const priced = {
    ...base,
    prices: [new BN(80_000_000), new BN(1), new BN(1)],
    price_decimals: [6, 6, 6],
    usdc_burned: new BN(150_000_000),
  };
  const cases: Array<[string, Record<string, unknown>]> = [
    ["BuyV4Executed", {
      ...priced,
      origin: 2,
      price_ts: [new BN(90), new BN(90), new BN(90)],
      usdc_each: new BN(50_000_000),
      fee_usdc: new BN(100_000),
    }],
    ["BuyV3Executed", { ...priced, fee_usdc: new BN(100_000) }],
    ["BuyV2Executed", priced],
    ["SimulateBuyExecuted", { ...base, usdc_burned: new BN(150_000_000) }],
    ["RunRecorded", base],
  ];
  const program = programId();
  for (const [name, fields] of cases) {
    const parsed = entriesFromLogs(logsFor(program, eventBody(name, fields)), program, owner.toBase58(), other.toBase58(), "sig");
    assert.equal(parsed.length, 1, name);
    assert.equal(parsed[0].runIndex, 4, name);
    assert.equal(parsed[0].source, "event");
  }

  const v4 = entryFromBuyEvent(
    "BuyV4Executed",
    { run_index: 1, origin: 1, mints: [], amounts: [], usdc_each: BigInt(3), usdc_burned: BigInt(9) },
    owner.toBase58(),
    owner.toBase58(),
    "s",
  );
  assert.equal(v4?.origin, "auto");
  const manual = entryFromBuyEvent(
    "BuyV2Executed",
    { run_index: 1, mints: [], amounts: [], usdc_burned: BigInt(9) },
    owner.toBase58(),
    owner.toBase58(),
    "s",
  );
  assert.equal(manual?.origin, "manual");
  assert.equal(manual?.usdcEach, BigInt(3));
  const auto = entryFromBuyEvent(
    "BuyV2Executed",
    { run_index: 1, mints: [], amounts: [], usdc_burned: BigInt(9) },
    other.toBase58(),
    owner.toBase58(),
    "s",
  );
  assert.equal(auto?.origin, "auto");

  const foreign = Keypair.generate().publicKey;
  const hidden = entriesFromLogs(
    [
      `Program ${program.toBase58()} invoke [1]`,
      `Program ${foreign.toBase58()} invoke [2]`,
      `Program data: ${eventBody("RunRecorded", base)}`,
      `Program ${foreign.toBase58()} success`,
      `Program ${program.toBase58()} success`,
    ],
    program,
    owner.toBase58(),
    owner.toBase58(),
    "sig",
  );
  assert.equal(hidden.length, 0);

  const event: HistoryEntry = {
    runIndex: 4,
    origin: "manual",
    mints: [ANTHROPIC],
    amounts: [BigInt(1)],
    usdcEach: BigInt(1),
    signature: "e",
    slot: 1,
    ts: 9,
    source: "event",
    priceKnown: true,
    prices: [BigInt(1)],
  };
  const chain: HistoryEntry = { ...event, source: "chain", signature: "c", priceKnown: false };
  const snap: HistoryEntry = { ...event, source: "snapshot", signature: "s" };
  const card: HistoryEntry = { ...event, source: "card", signature: "" };
  assert.equal(mergeHistory([[chain], [snap], [card], [event]])[0].source, "event");
  assert.equal(mergeHistory([[card], [snap]])[0].source, "snapshot");
  assert.equal(mergeHistory([[card], [chain]])[0].source, "chain");

  const legacy = historyToLotInputs([
    {
      runIndex: 3,
      origin: null,
      mints: [ANTHROPIC],
      amounts: [BigInt(50_000_000)],
      usdcEach: BigInt(0),
      signature: "",
      slot: 1,
      ts: 9,
      source: "chain",
      priceKnown: false,
      priceMissing: true,
    },
  ]);
  const legacyLots = runLots(legacy.runs, legacy.decoded);
  const direct = runLots(
    [{ runIndex: 3, ts: 9, mints: [ANTHROPIC], amountsUsd: [50] }],
    new Map([[3, null]]),
  );
  assert.equal(legacyLots[0].usdcCost, 50);
  assert.equal(legacyLots[0].usdcCost, direct[0].usdcCost);
  assert.equal(legacyLots[0].units, null);

  const pricedLots = runLots(
    ...(() => {
      const input = historyToLotInputs([
        {
          runIndex: 3,
          origin: "manual",
          mints: [ANTHROPIC],
          amounts: [BigInt(2_500_000)],
          prices: [BigInt(80_000_000)],
          priceDecimals: [6],
          usdcEach: BigInt(50_000_000),
          signature: "e",
          slot: 1,
          ts: 9,
          source: "event",
          priceKnown: true,
        },
      ]);
      return [input.runs, input.decoded] as const;
    })(),
  );
  assert.equal(pricedLots[0].units, 2.5);
  assert.equal(pricedLots[0].usdcCost, 50);
  assert.equal(pricedLots[0].buyPrice, 80);

  const data = new Map<string, string>();
  const storage: HistoryCacheStorage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
  let txCalls = 0;
  const signature = "hist-sig";
  const connection = {
    async getSignaturesForAddress() {
      return [{ signature }];
    },
    async getTransaction() {
      txCalls += 1;
      return {
        meta: { logMessages: logsFor(program, eventBody("RunRecorded", { ...base, run_index: new BN(8) })) },
        transaction: { message: { staticAccountKeys: [owner] } },
      };
    },
  };
  const first = await fetchHistoryEvents({
    connection,
    address: userConfigPda(owner)[0],
    owner: owner.toBase58(),
    programId: program,
    storage,
    cap: 100,
  });
  const second = await fetchHistoryEvents({
    connection,
    address: userConfigPda(owner)[0],
    owner: owner.toBase58(),
    programId: program,
    storage,
    cap: 100,
  });
  assert.equal(first.fetched, 1);
  assert.equal(second.fetched, 0);
  assert.equal(txCalls, 1);
  assert.equal(first.entries[0]?.runIndex, 8);
  assert.equal(entriesFromTransaction(
    {
      meta: { logMessages: logsFor(program, eventBody("RunRecorded", base)) },
      transaction: { message: { accountKeys: [owner.toBase58()] } },
    },
    "sig",
    owner.toBase58(),
    program,
  )[0]?.origin, "manual");
  assert.deepEqual(historyRpcCost(20), { signatures: 1, transactions: 4, total: 5 });
  assert.deepEqual(historyRpcCost(0), { signatures: 0, transactions: 0, total: 0 });
});

test("card confirmation does not wait for a RunRecord", () => {
  const hash = Uint8Array.from(ZERO_SIGNATURE_HASH);
  const card = {
    hasLastRun: true,
    lastRunIndex: new BN(4),
    lastOrigin: ORIGIN_MANUAL,
    lastSignatureHash: hash,
  };
  assert.equal(
    cardBuyConfirmed({ expectedRunIndex: 4, card, sentSignatureHash: hash }),
    true,
  );
  assert.equal(
    cardBuyConfirmed({
      expectedRunIndex: 4,
      card: { ...card, lastOrigin: 1 },
      sentSignatureHash: hash,
    }),
    false,
  );
  assert.equal(
    buyRefreshSettled({
      prevRunCount: 0,
      expectedRunIndex: 4,
      runs: [],
      prices: new Map(),
      balances: [],
      nowMs: Date.now(),
      card: { card, sentSignatureHash: hash },
    }),
    true,
  );
  assert.equal(
    buyRefreshSettled({
      prevRunCount: 0,
      expectedRunIndex: 4,
      runs: [],
      prices: new Map(),
      balances: [],
      nowMs: Date.now(),
    }),
    false,
  );
});

test("close_user withdraws a full vault, closes an empty one, and legacy stays disabled", async () => {
  const owner = Keypair.generate();
  const { Connection } = await import("@solana/web3.js");
  const rpc = new Connection("http://127.0.0.1:1", "confirmed");
  const wallet = {
    publicKey: owner.publicKey,
    signTransaction: async <T>(tx: T) => tx,
    signAllTransactions: async <T>(txs: T[]) => txs,
  };
  const provider = new AnchorProvider(rpc, wallet, { commitment: "confirmed" });
  const program = getProgram(provider);
  const usdc = new PublicKey(MOCK_USDC_MINT);
  const withFunds = await buildCloseInstructions(program, owner.publicKey, usdc, BigInt(1_500_000));
  assert.equal(withFunds.length, 2);
  const empty = await buildCloseInstructions(program, owner.publicKey, usdc, BigInt(0));
  assert.equal(empty.length, 1);
  const closeNames = idl.instructions.find((item) => item.name === "close_user")?.accounts.map((item) => item.name);
  assert.deepEqual(closeNames, ["owner", "user_config", "vault", "token_program"]);
  assert.equal(empty[0].keys.length, 4);
  assert.equal(empty[0].keys[0].pubkey.toBase58(), owner.publicKey.toBase58());
  assert.equal(withFunds[0].keys.some((key) => key.pubkey.equals(ownerAtaAddress(owner.publicKey, usdc))), true);
  assert.equal(closeSubmitPlan(BigInt(0), 200), "close-only");
  assert.equal(closeSubmitPlan(BigInt(1), 800), "single");
  assert.equal(closeSubmitPlan(BigInt(1), 1233), "two-step");
  assert.equal(
    closeAccountUi({ mode: "legacy", accountUpdating: false, connected: true }).enabled,
    false,
  );
  assert.equal(
    closeAccountUi({ mode: "legacy", accountUpdating: false, connected: true }).hintKey,
    "settings.closeAfterUpdate",
  );
  assert.equal(closeAccountUi({ mode: "card", accountUpdating: false, connected: true }).enabled, true);
  assert.equal(closeAccountUi({ mode: "card", accountUpdating: true, connected: true }).enabled, false);
  assert.equal(accountFeeRefundSol(2_000_000, 199_640), 0.00219964);

  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
  const ownerKey = owner.publicKey.toBase58();
  storage.setItem(historyCacheKey(ownerKey), "{}");
  storage.setItem(scopedLsKey(LS_AUTO_WEEKLY_BUY, ownerKey), "1");
  storage.setItem(scopedLsKey(LS_WEEKLY_BUDGET, ownerKey), "10");
  clearClosedOwnerState(storage, ownerKey);
  assert.equal(storage.getItem(historyCacheKey(ownerKey)), null);
  assert.equal(storage.getItem(scopedLsKey(LS_WEEKLY_BUDGET, ownerKey)), null);

  const hook = readFileSync(new URL("../lib/hooks/usePredca.ts", import.meta.url), "utf8");
  const closeAt = hook.indexOf("async function closeAccount");
  const closeFn = hook.slice(closeAt, hook.indexOf("return {", closeAt));
  assert.match(closeFn, /configState: "missing"/);
  assert.match(closeFn, /planned\.plan === "two-step"/);
  assert.match(closeFn, /clearClosedOwnerState/);
  const previousStorage = (globalThis as { localStorage?: Storage }).localStorage;
  (globalThis as { localStorage?: Storage }).localStorage = storage;
  try {
    writeStoredLocale("en");
    assert.equal(
      parseAnchorError(new Error("Error Number: 6023")),
      translate("en", "tx.err.vaultNotEmpty"),
    );
  } finally {
    if (previousStorage === undefined) {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    } else {
      (globalThis as { localStorage?: Storage }).localStorage = previousStorage;
    }
  }
  assert.doesNotMatch(translate("en", "tx.err.vaultNotEmpty"), /keeper/i);
  assert.doesNotMatch(translate("pl", "settings.closeTokensStay"), /keeper/i);
});

test("owner_ata_missing stays queued and does not add a wallet-prep card", () => {
  assert.equal(
    classifyDefer({ phase: "deferred", deferReason: "owner_ata_missing" }),
    "queued",
  );
  assert.equal(
    classifyDefer({ phase: "error", deferReason: "owner_ata_missing", error: "missing" }),
    "queued",
  );
  assert.equal(
    classifyDefer({ phase: "deferred", deferReason: "user_not_migrated" }),
    "updating",
  );
  assert.equal(classifyDefer({ phase: "deferred", error: "later" }), "queued");
  assert.equal(
    classifyDefer({ phase: "error", error: "keeper ma za mało sol" }),
    "queued",
  );
  const overview = readFileSync(new URL("../components/OverviewView.tsx", import.meta.url), "utf8");
  const settings = readFileSync(new URL("../components/SettingsView.tsx", import.meta.url), "utf8");
  assert.equal(overview.includes("Przygotuj portfel"), false);
  assert.equal(settings.includes("Przygotuj portfel"), false);
  assert.match(overview, /account\.updating/);
  assert.equal(APP_VERSION, "5.0.26");
});

test("receipt snapshot skips a placeholder, a bad sha, and an unknown version", async () => {
  const raw = readFileSync(new URL("../public/data/receipts-snapshot-devnet.json", import.meta.url));
  const shaFile = readFileSync(
    new URL("../public/data/receipts-snapshot-devnet.json.sha256", import.meta.url),
    "utf8",
  );
  const digest = createHash("sha256").update(raw).digest("hex");
  assert.equal(shaFile.split(/\s+/)[0], digest);
  assert.equal(await sha256Hex(raw), digest);
  const placeholder = JSON.parse(raw.toString("utf8")) as { placeholder?: boolean; count?: number };
  assert.equal(placeholder.placeholder, true);
  assert.equal(placeholder.count, 0);

  const owner = Keypair.generate().publicKey.toBase58();
  const other = Keypair.generate().publicKey.toBase58();
  const file = {
    version: 1,
    cluster: "devnet",
    programId: programId().toBase58(),
    count: 2,
    receipts: [
      {
        type: "RunRecord" as const,
        pubkey: "run-record-7",
        owner,
        run_index: 7,
        mints: [ANTHROPIC],
        amounts: [2_500_000],
        firstSignature: "snap-sig",
        firstFeePayer: owner,
        slot: 3,
        ts: 9,
      },
      {
        type: "RunPrice" as const,
        pubkey: "run-price-7",
        owner,
        run_index: 7,
        prices: [80_000_000],
        price_decimals: [6],
        price_ts: [9],
        usdc_spent_each: 50_000_000,
        firstFeePayer: owner,
      },
      {
        type: "RunRecord" as const,
        pubkey: "run-record-8",
        owner: other,
        run_index: 8,
        mints: [ANTHROPIC],
        amounts: [1],
        firstFeePayer: other,
      },
    ],
  };
  const body = JSON.stringify(file);
  const good = createHash("sha256").update(body).digest("hex");
  resetReceiptSnapshotForTests();
  const loaded = await loadReceiptSnapshot({
    basePath: "/prestocks-dca-noir",
    fetchImpl: async (url) => {
      const href = String(url);
      if (href.endsWith(".sha256")) return new Response(`${good}  receipts-snapshot-devnet.json\n`);
      return new Response(body);
    },
  });
  assert.ok(loaded);
  const rows = entriesFromSnapshot(loaded, owner);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].origin, "manual");
  assert.equal(rows[0].priceKnown, true);
  assert.equal(rows[0].usdcEach, BigInt(50_000_000));
  assert.equal(rows[0].source, "snapshot");
  const autoFile = {
    ...file,
    receipts: file.receipts.map((row) =>
      row.owner === owner ? { ...row, firstFeePayer: other } : row,
    ),
  };
  assert.equal(entriesFromSnapshot(autoFile, owner)[0].origin, "auto");

  resetReceiptSnapshotForTests();
  const skippedSha = await loadReceiptSnapshot({
    basePath: "/base",
    force: true,
    fetchImpl: async (url) => {
      if (String(url).endsWith(".sha256")) return new Response("deadbeef  x\n");
      return new Response(body);
    },
  });
  assert.equal(skippedSha, null);

  resetReceiptSnapshotForTests();
  const unknown = await loadReceiptSnapshot({
    basePath: "/base",
    force: true,
    fetchImpl: async (url) => {
      const text = JSON.stringify({ ...file, version: 9 });
      const sum = createHash("sha256").update(text).digest("hex");
      if (String(url).endsWith(".sha256")) return new Response(`${sum}  x\n`);
      return new Response(text);
    },
  });
  assert.equal(unknown, null);
  assert.equal(validateReceiptSnapshot({ version: 9, receipts: [] }), null);
  assert.equal(validateReceiptSnapshot({ ...file, placeholder: true }), null);

  const chain: HistoryEntry = {
    runIndex: 7,
    origin: null,
    mints: [ANTHROPIC],
    amounts: [BigInt(2_500_000)],
    usdcEach: BigInt(50_000_000),
    signature: "chain",
    slot: 3,
    ts: 9,
    source: "chain",
    priceKnown: true,
    prices: [BigInt(80_000_000)],
  };
  const event: HistoryEntry = { ...chain, source: "event", signature: "event" };
  assert.equal(mergeHistory([rows, [chain], [event]])[0].source, "event");
  assert.equal(mergeHistory([rows, [chain]])[0].source, "chain");

  const card = entryFromCard(
    decodeUserConfig(cardBytes(new PublicKey(owner), BigInt(7), true)),
  );
  assert.equal(card?.source, "card");
  assert.equal(mergeHistory([card ? [card] : [], rows])[0].source, "snapshot");
});
