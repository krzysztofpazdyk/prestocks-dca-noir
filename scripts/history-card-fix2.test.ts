/**
 * noir 5.0.26 follow-up. Offline. No RPC, no devnet, no mainnet.
 * Same session reloads history after close and initialize.
 * A null getTransaction does not move the history cursor.
 * A fee label follows generation and runIndex.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BorshCoder, BN, type Idl } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import idl from "../idl/predca.json";
import { feeUsdForRun, historyFeeLabel } from "../lib/fee-display";
import { mergeHistory, type HistoryEntry } from "../lib/history-entry";
import {
  committedHistoryNewest,
  entriesFromTransaction,
  fetchHistoryEvents,
  historyCacheKey,
  historyReadsArmed,
  historyRefreshDecision,
  shouldReloadHistoryAfterInit,
  type HistoryCacheStorage,
  type HistoryTransaction,
} from "../lib/history-events";
import { translate } from "../lib/i18n";
import { setNumberLocaleForTests } from "../lib/number-format";
import { programId } from "../lib/predca";
import {
  receiptEntriesForOwner,
  resetReceiptSnapshotForTests,
} from "../lib/receipts-snapshot";

const coder = new BorshCoder(idl as Idl);
const zeroHash = Array.from({ length: 32 }, () => 0);

function eventBody(name: string, fields: Record<string, unknown>): string {
  const body = coder.types.encode(name, fields);
  const event = idl.events.find((item) => item.name === name);
  if (!event) throw new Error(name);
  return Buffer.concat([Buffer.from(event.discriminator), Buffer.from(body)]).toString("base64");
}

function memoryStorage(): HistoryCacheStorage & { dump(): Map<string, string> } {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
    dump: () => data,
  };
}

function buyTx(
  owner: PublicKey,
  program: PublicKey,
  runIndex: number,
  slot: number,
): HistoryTransaction {
  const mints = [0, 1, 2].map(() => Keypair.generate().publicKey);
  const fields = {
    owner,
    run_index: new BN(runIndex),
    mints,
    amounts: [new BN(1_000_000), new BN(1_000_000), new BN(1_000_000)],
    signature_hash: zeroHash,
    slot: new BN(slot),
    ts: new BN(slot),
    prices: [new BN(1), new BN(1), new BN(1)],
    price_decimals: [6, 6, 6],
    usdc_burned: new BN(3_000_000),
  };
  return {
    slot,
    blockTime: slot,
    meta: {
      err: null,
      logMessages: [
        `Program ${program.toBase58()} invoke [1]`,
        `Program data: ${eventBody("BuyV2Executed", fields)}`,
        `Program ${program.toBase58()} success`,
      ],
    },
    transaction: { message: { staticAccountKeys: [owner] } },
  };
}

function closeTx(program: PublicKey, slot: number): HistoryTransaction {
  return {
    slot,
    blockTime: slot,
    meta: {
      err: null,
      logMessages: [
        `Program ${program.toBase58()} invoke [1]`,
        "Program log: Instruction: CloseUser",
        `Program ${program.toBase58()} success`,
      ],
    },
  };
}

function snapshotFetch(owner: string): typeof fetch {
  const body = JSON.stringify({
    version: 1,
    cluster: "devnet",
    receipts: [
      {
        type: "RunRecord",
        pubkey: "snap-record",
        owner,
        run_index: 4,
        mints: [Keypair.generate().publicKey.toBase58()],
        amounts: [2_000_000],
        slot: 3,
        ts: 3,
        firstFeePayer: owner,
        firstSignature: "snap-sig",
      },
    ],
  });
  const sum = createHash("sha256").update(body).digest("hex");
  return async (url) => {
    if (String(url).endsWith(".sha256")) {
      return new Response(`${sum}  receipts-snapshot-devnet.json\n`);
    }
    return new Response(body);
  };
}

test("the cursor stays put when any getTransaction on the page is null", () => {
  const read = new Set(["older", "empty", "new"]);
  assert.equal(committedHistoryNewest(["miss", "older"], new Set(["older"]), null), null);
  assert.equal(committedHistoryNewest(["miss", "older"], new Set(["older"]), "anchor"), "anchor");
  assert.equal(committedHistoryNewest(["new", "hole", "old"], new Set(["new", "old"]), "prev"), "prev");
  assert.equal(committedHistoryNewest(["empty", "older"], read, null), "empty");
  assert.equal(committedHistoryNewest([], read, "prev"), "prev");
});

test("a null newest signature is fetched again and then joins the list", async () => {
  const owner = Keypair.generate().publicKey;
  const program = programId();
  const storage = memoryStorage();
  const queries: Array<string | null> = [];
  const txCalls: string[] = [];
  let missReads = 0;
  const connection = {
    async getSignaturesForAddress(_address: PublicKey, options?: { until?: string }) {
      queries.push(options?.until ?? null);
      return [{ signature: "miss" }, { signature: "older" }];
    },
    async getTransaction(signature: string) {
      txCalls.push(signature);
      if (signature === "miss") {
        missReads += 1;
        if (missReads === 1) return null;
        return buyTx(owner, program, 0, 20);
      }
      return buyTx(owner, program, 1, 10);
    },
  };
  const args = {
    connection,
    address: owner,
    owner: owner.toBase58(),
    programId: program,
    storage,
    cap: 10,
  };
  const first = await fetchHistoryEvents(args);
  assert.equal(first.newest, null);
  assert.notEqual(first.newest, "miss");
  assert.equal(first.entries.length, 1);
  assert.equal(first.entries[0]?.signature, "older");
  assert.equal(storage.getItem(historyCacheKey(owner.toBase58()))?.includes("miss"), false);
  assert.equal(storage.getItem(historyCacheKey(owner.toBase58()))?.includes("older"), true);

  const second = await fetchHistoryEvents({
    ...args,
    ...(first.newest ? { until: first.newest } : {}),
  });
  assert.equal(queries[1], null);
  assert.equal(txCalls.filter((signature) => signature === "miss").length, 2);
  assert.equal(txCalls.filter((signature) => signature === "older").length, 1);
  assert.equal(second.entries.some((entry) => entry.signature === "miss"), true);
  assert.equal(second.newest, "miss");
});

test("a successful read with no buys can become the cursor", async () => {
  const owner = Keypair.generate().publicKey;
  const program = programId();
  const storage = memoryStorage();
  let reads = 0;
  const connection = {
    async getSignaturesForAddress() {
      return [{ signature: "empty" }];
    },
    async getTransaction() {
      reads += 1;
      const empty: HistoryTransaction = { slot: 4, meta: { err: null, logMessages: [] } };
      return empty;
    },
  };
  const args = {
    connection,
    address: owner,
    owner: owner.toBase58(),
    programId: program,
    storage,
    cap: 10,
  };
  const first = await fetchHistoryEvents(args);
  const second = await fetchHistoryEvents({ ...args, until: first.newest ?? undefined });
  assert.equal(first.entries.length, 0);
  assert.equal(first.newest, "empty");
  assert.equal(first.fetched, 1);
  assert.equal(second.fetched, 0);
  assert.equal(reads, 1);
});

test("close then initialize reloads merged history in the same session", async () => {
  const owner = Keypair.generate().publicKey;
  const key = owner.toBase58();
  const program = programId();
  const storage = memoryStorage();
  let signatureReads = 0;
  const connection = {
    async getSignaturesForAddress() {
      signatureReads += 1;
      return [
        { signature: "buy-new" },
        { signature: "close-ok" },
        { signature: "buy-0" },
      ];
    },
    async getTransaction(signature: string) {
      if (signature === "buy-0") return buyTx(owner, program, 0, 10);
      if (signature === "close-ok") return closeTx(program, 40);
      if (signature === "buy-new") return buyTx(owner, program, 0, 50);
      return null;
    },
  };

  let cursorOwner: string | null = null;
  let newest: string | null = null;
  let accountReady = false;
  let events: HistoryEntry[] = [];
  let snapshot: HistoryEntry[] = [];
  let closes = [] as Awaited<ReturnType<typeof fetchHistoryEvents>>["closes"];

  async function loadFull(): Promise<void> {
    const page = await fetchHistoryEvents({
      connection,
      address: owner,
      owner: key,
      programId: program,
      storage,
      cap: 10,
      ...(newest ? { until: newest } : {}),
    });
    events = page.entries;
    closes = page.closes;
    if (page.newest) newest = page.newest;
    resetReceiptSnapshotForTests();
    snapshot = await receiptEntriesForOwner(key, { fetchImpl: snapshotFetch(key) });
  }

  const pollLoads = () =>
    historyRefreshDecision({ visible: true, inFlight: false }) === "poll" &&
    historyReadsArmed({ owner: cursorOwner }, key);

  // Wallet connects. The account read has not finished, so this is not the
  // post-close reload. The owner effect still loads once.
  assert.equal(
    shouldReloadHistoryAfterInit({ cursorOwner, ownerKey: key, accountReady }),
    false,
  );
  cursorOwner = key;
  await loadFull();
  accountReady = true;
  assert.equal(
    shouldReloadHistoryAfterInit({ cursorOwner, ownerKey: key, accountReady: true }),
    false,
  );
  const openList = mergeHistory([events, snapshot], closes);
  assert.equal(openList.length, 3);
  const readsAfterOpen = signatureReads;

  // Successful close_user. Same wallet. History cursor drops. Poll stays off.
  cursorOwner = null;
  newest = null;
  accountReady = false;
  events = [];
  snapshot = [];
  closes = [];
  storage.removeItem?.(historyCacheKey(key));
  assert.equal(historyReadsArmed({ owner: cursorOwner }, key), false);
  assert.equal(
    shouldReloadHistoryAfterInit({ cursorOwner, ownerKey: key, accountReady: false }),
    false,
  );
  assert.equal(pollLoads(), false);
  assert.equal(signatureReads, readsAfterOpen);
  const gapList = mergeHistory([events, snapshot], closes);
  assert.equal(gapList.length, 0);

  // initialize_user in the same session. No remount. Reload events and the snapshot.
  accountReady = true;
  assert.equal(
    shouldReloadHistoryAfterInit({ cursorOwner, ownerKey: key, accountReady: true }),
    true,
  );
  cursorOwner = key;
  newest = null;
  await loadFull();
  assert.ok(signatureReads > readsAfterOpen);
  assert.equal(historyReadsArmed({ owner: cursorOwner }, key), true);
  assert.equal(pollLoads(), true);
  const merged = mergeHistory([events, snapshot], closes);
  assert.deepEqual(
    merged.map((row) => [row.generation, row.runIndex, row.source]),
    [
      [0, 0, "event"],
      [0, 4, "snapshot"],
      [1, 0, "event"],
    ],
  );
  assert.equal(merged.filter((row) => row.previousAccount).length, 2);
  assert.equal(merged.filter((row) => !row.previousAccount).length, 1);

  // rememberBuyEvent stays off in the gap and appends once the cursor is armed.
  const gapRemember = historyReadsArmed({ owner: null }, key)
    ? entriesFromTransaction(buyTx(owner, program, 1, 70), "buy-remember", key, program)
    : [];
  assert.equal(gapRemember.length, 0);
  const remembered = historyReadsArmed({ owner: cursorOwner }, key)
    ? entriesFromTransaction(buyTx(owner, program, 1, 70), "buy-remember", key, program)
    : [];
  assert.equal(remembered.length, 1);
  const withNew = mergeHistory([[...events, ...remembered], snapshot], closes);
  assert.equal(withNew.some((row) => row.signature === "buy-remember" && row.generation === 1), true);
  assert.equal(withNew.length, 4);

  const hook = readFileSync(new URL("../lib/hooks/usePredca.ts", import.meta.url), "utf8");
  assert.match(hook, /shouldReloadHistoryAfterInit\(/);
  assert.match(hook, /historyReadsArmed\(/);
  assert.match(hook, /loadFullHistoryRef/);
  const view = readFileSync(new URL("../components/HistoryView.tsx", import.meta.url), "utf8");
  assert.match(view, /predca\.historyGeneration/);
});

test("fee labels follow generation and do not cross accounts", () => {
  setNumberLocaleForTests("en-US");
  try {
    const tEn = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
    const fees = [
      { runIndex: 0, feeUsd: 0.0023, generation: 0 },
      { runIndex: 0, feeUsd: 0.0041, generation: 1 },
      { runIndex: 1, feeUsd: 0.0023 },
    ];
    assert.equal(historyFeeLabel(feeUsdForRun(fees, 0, 0, 1), tEn), "fee 0.0023 USD");
    assert.equal(historyFeeLabel(feeUsdForRun(fees, 0, 1, 1), tEn), "fee 0.0041 USD");
    assert.equal(feeUsdForRun(fees, 1, 1, 1), 0.0023);
    assert.equal(feeUsdForRun(fees, 1, 0, 1), undefined);
    assert.equal(feeUsdForRun([{ runIndex: 1, feeUsd: 0.0023 }], "1"), 0.0023);
    assert.equal(feeUsdForRun([{ runIndex: 1, feeUsd: 0.0023, generation: 0 }], "1"), 0.0023);
    assert.equal(feeUsdForRun([{ runIndex: 2, feeUsd: 0 }], 2), 0);
    assert.equal(feeUsdForRun(fees, 9), undefined);
  } finally {
    setNumberLocaleForTests(null);
  }
});
