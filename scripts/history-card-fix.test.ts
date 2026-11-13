/**
 * noir 5.0.26 history fixes. Offline. No RPC, no devnet, no mainnet.
 * Failed transactions are not purchases. A missed read is not cached.
 * Closed and new accounts share one list, keyed by generation and runIndex.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BorshCoder, BN, type Idl } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import idl from "../idl/predca.json";
import { clearClosedOwnerState } from "../lib/close-account";
import {
  accountGeneration,
  historyToLotInputs,
  mergeHistory,
  originFromCode,
  type HistoryEntry,
} from "../lib/history-entry";
import {
  HISTORY_CACHE_PREFIX,
  HISTORY_INITIAL_SIGNATURE_CAP,
  HISTORY_REFRESH_MS,
  closeMarkFromTransaction,
  createHistoryRefreshQueue,
  entriesFromTransaction,
  fetchHistoryEvents,
  historyCacheKey,
  historyCacheLegacyKey,
  historyIncrementalQuery,
  historyRefreshDecision,
  type HistoryCacheStorage,
  type HistoryTransaction,
} from "../lib/history-events";
import { translate } from "../lib/i18n";
import { buildPositions, runLots } from "../lib/position-value";
import { programId } from "../lib/predca";
import {
  entriesFromSnapshot,
  loadReceiptSnapshot,
  resetReceiptSnapshotForTests,
} from "../lib/receipts-snapshot";
import { historyRunMetaText } from "../lib/run-origin";
import { runsNewestFirst } from "../lib/run-order";
import { ORIGIN_AUTO, ORIGIN_MANUAL } from "../lib/user-config";

const ANTHROPIC = "3MFLVffGvwRVpo4iGvALruCwZmQQvSDuwyFqgiaknZ5V";
const coder = new BorshCoder(idl as Idl);
const zeroHash = Array.from({ length: 32 }, () => 0);

function eventBody(name: string, fields: Record<string, unknown>): string {
  const body = coder.types.encode(name, fields);
  const event = idl.events.find((item) => item.name === name);
  if (!event) throw new Error(name);
  return Buffer.concat([Buffer.from(event.discriminator), Buffer.from(body)]).toString("base64");
}

function buy(runIndex: number, slot: number, usdcRaw: number, source: HistoryEntry["source"] = "event"): HistoryEntry {
  return {
    runIndex,
    origin: "manual",
    mints: [ANTHROPIC],
    amounts: [BigInt(1_000_000)],
    prices: [BigInt(80_000_000)],
    priceDecimals: [6],
    usdcEach: BigInt(usdcRaw),
    signature: `${source}-${slot}-${runIndex}`,
    slot,
    ts: slot,
    source,
    priceKnown: true,
  };
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

test("origin code 0 has no label, manual and auto keep theirs", () => {
  assert.equal(originFromCode(0), null);
  assert.equal(originFromCode(null), null);
  assert.equal(originFromCode(undefined), null);
  assert.equal(originFromCode(9), null);
  assert.equal(originFromCode(ORIGIN_MANUAL), "manual");
  assert.equal(originFromCode(ORIGIN_AUTO), "auto");
  const line = historyRunMetaText({
    locale: "en",
    index: "0",
    slot: "1",
    budgetText: "$1.00",
    origin: originFromCode(0),
  });
  assert.doesNotMatch(line, /\bauto\b/);
  assert.doesNotMatch(line, /\bmanual\b/);
  assert.match(
    historyRunMetaText({
      locale: "en",
      index: "0",
      slot: "1",
      budgetText: "$1.00",
      origin: "manual",
    }),
    /manual/,
  );
  assert.equal(translate("pl", "history.previousAccount"), "poprzednie konto");
  assert.equal(translate("en", "history.previousAccount"), "previous account");
  assert.doesNotMatch(translate("pl", "history.previousAccount"), /keeper/i);
  assert.doesNotMatch(translate("en", "history.previousAccount"), /keeper/i);
});

test("a failed transaction is not a purchase and is cached as empty", async () => {
  const owner = Keypair.generate().publicKey;
  const program = programId();
  const mints = [0, 1, 2].map(() => Keypair.generate().publicKey);
  const fields = {
    owner,
    run_index: new BN(0),
    mints,
    amounts: [new BN(1), new BN(1), new BN(1)],
    signature_hash: zeroHash,
    slot: new BN(10),
    ts: new BN(10),
    prices: [new BN(1), new BN(1), new BN(1)],
    price_decimals: [6, 6, 6],
    usdc_burned: new BN(3),
  };
  const logs = [
    `Program ${program.toBase58()} invoke [1]`,
    `Program data: ${eventBody("BuyV2Executed", fields)}`,
    `Program log: Instruction: CloseUser`,
    `Program ${program.toBase58()} failed`,
  ];
  const failed: HistoryTransaction = {
    slot: 40,
    blockTime: 40,
    meta: { err: { InstructionError: [0, { Custom: 6023 }] }, logMessages: logs },
  };
  assert.deepEqual(entriesFromTransaction(failed, "bad", owner.toBase58(), program), []);
  assert.equal(closeMarkFromTransaction(failed, "bad", program), null);

  const storage = memoryStorage();
  let reads = 0;
  const connection = {
    async getSignaturesForAddress() {
      return [{ signature: "bad" }];
    },
    async getTransaction() {
      reads += 1;
      return failed;
    },
  };
  const first = await fetchHistoryEvents({
    connection,
    address: owner,
    owner: owner.toBase58(),
    programId: program,
    storage,
    cap: 10,
  });
  const second = await fetchHistoryEvents({
    connection,
    address: owner,
    owner: owner.toBase58(),
    programId: program,
    storage,
    cap: 10,
  });
  assert.equal(first.entries.length, 0);
  assert.equal(first.closes.length, 0);
  assert.equal(first.fetched, 1);
  assert.equal(second.fetched, 0);
  assert.equal(reads, 1);
});

test("a null transaction is not cached and is retried", async () => {
  const owner = Keypair.generate().publicKey;
  const program = programId();
  const storage = memoryStorage();
  let reads = 0;
  const connection = {
    async getSignaturesForAddress() {
      return [{ signature: "missing" }];
    },
    async getTransaction() {
      reads += 1;
      return null;
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
  const second = await fetchHistoryEvents(args);
  assert.equal(first.fetched, 1);
  assert.equal(second.fetched, 1);
  assert.equal(reads, 2);
  const saved = storage.getItem(historyCacheKey(owner.toBase58())) ?? "";
  assert.equal(saved.includes("missing"), false);
});

test("one transaction keeps only this owner's buy events", async () => {
  const owner = Keypair.generate().publicKey;
  const other = Keypair.generate().publicKey;
  const program = programId();
  const mints = [0, 1, 2].map(() => Keypair.generate().publicKey);
  const fields = (who: PublicKey, run: number) => ({
    owner: who,
    run_index: new BN(run),
    mints,
    amounts: [new BN(1), new BN(1), new BN(1)],
    signature_hash: zeroHash,
    slot: new BN(12),
    ts: new BN(12),
    prices: [new BN(1), new BN(1), new BN(1)],
    price_decimals: [6, 6, 6],
    usdc_burned: new BN(9),
  });
  const tx: HistoryTransaction = {
    slot: 12,
    meta: {
      err: null,
      logMessages: [
        `Program ${program.toBase58()} invoke [1]`,
        `Program data: ${eventBody("BuyV2Executed", fields(owner, 1))}`,
        `Program data: ${eventBody("BuyV2Executed", fields(other, 2))}`,
        `Program ${program.toBase58()} success`,
      ],
    },
    transaction: { message: { staticAccountKeys: [owner] } },
  };
  const rows = entriesFromTransaction(tx, "both", owner.toBase58(), program);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.runIndex, 1);
});

test("closed account and new account stay five rows and still fund the position", () => {
  const program = programId();
  const closeLogs = [
    `Program ${program.toBase58()} invoke [1]`,
    "Program log: Instruction: CloseUser",
    `Program ${program.toBase58()} success`,
  ];
  const failedClose = closeMarkFromTransaction(
    {
      slot: 40,
      blockTime: 40,
      meta: { err: { InstructionError: [0, "Custom"] }, logMessages: closeLogs },
    },
    "close-fail",
    program,
  );
  assert.equal(failedClose, null);
  const closed = closeMarkFromTransaction(
    {
      slot: 40,
      blockTime: 40,
      meta: { err: null, logMessages: closeLogs },
    },
    "close-ok",
    program,
  );
  assert.equal(closed?.slot, 40);

  const disc = idl.instructions.find((item) => item.name === "close_user")?.discriminator ?? [];
  const fromInstruction = closeMarkFromTransaction(
    {
      slot: 40,
      blockTime: 40,
      meta: { err: null, logMessages: [] },
      transaction: {
        message: {
          accountKeys: [program.toBase58()],
          instructions: [{ programIdIndex: 0, data: disc }],
        },
      },
    },
    "close-ix",
    program,
  );
  assert.equal(fromInstruction?.slot, 40);

  const purchases = [
    buy(0, 10, 10_000_000),
    buy(1, 20, 20_000_000),
    buy(2, 30, 30_000_000),
    buy(0, 50, 40_000_000),
    buy(1, 60, 50_000_000),
  ];
  const ignored = mergeHistory([purchases], []);
  assert.equal(ignored.length, 3);
  assert.ok(ignored.every((row) => (row.generation ?? 0) === 0));

  const rows = mergeHistory([purchases], [closed!]);
  assert.equal(rows.length, 5);
  assert.deepEqual(
    rows.map((row) => [row.generation, row.runIndex]),
    [
      [0, 0],
      [0, 1],
      [0, 2],
      [1, 0],
      [1, 1],
    ],
  );
  assert.equal(rows.filter((row) => row.previousAccount).length, 3);
  assert.equal(rows.filter((row) => !row.previousAccount).length, 2);
  const newest = runsNewestFirst(rows);
  assert.equal(newest[0]?.generation, 1);
  assert.equal(newest[0]?.runIndex, 1);

  const input = historyToLotInputs(rows);
  const priced = runLots(input.runs, input.decoded);
  assert.equal(priced.length, 5);
  const positions = buildPositions(
    priced,
    [{ name: priced[0]?.name ?? ANTHROPIC, amount: 5 }],
    { quotes: {}, fetchedAt: 0, source: "live", suspect: [], carried: [] },
  );
  assert.equal(positions[0]?.costUsd, 150);

  const card = buy(0, 5, 10_000_000, "card");
  const withCard = mergeHistory([[card, buy(0, 10, 10_000_000)]], [closed!]);
  assert.equal(withCard.find((row) => row.source === "card")?.generation, 1);
  assert.equal(withCard.find((row) => row.source === "event")?.generation, 0);
  assert.equal(accountGeneration(card, [closed!]), 1);

  const oldDump = { ...buy(7, 0, 10_000_000, "snapshot"), ts: 0 };
  assert.equal(mergeHistory([[oldDump]], [closed!])[0]?.generation, 0);
  const dated = { ...buy(7, 0, 10_000_000, "snapshot"), ts: 90 };
  assert.equal(mergeHistory([[dated]], [closed!])[0]?.generation, 1);
  const after = buy(8, 80, 10_000_000, "snapshot");
  assert.equal(mergeHistory([[after]], [closed!])[0]?.generation, 1);
  assert.equal(mergeHistory([[buy(8, 3, 10_000_000, "snapshot")]], [closed!])[0]?.generation, 0);
});

test("receipt snapshot requests are not force-cached", async () => {
  const seen: Array<string | undefined> = [];
  resetReceiptSnapshotForTests();
  const body = JSON.stringify({ version: 1, receipts: [] });
  const sum = createHash("sha256").update(body).digest("hex");
  await loadReceiptSnapshot({
    basePath: "/noir",
    force: true,
    fetchImpl: async (url, init) => {
      seen.push(init?.cache);
      if (String(url).endsWith(".sha256")) return new Response(`${sum}  receipts-snapshot-devnet.json\n`);
      return new Response(body);
    },
  });
  assert.deepEqual(seen, ["no-cache", "no-cache"]);
  const owner = Keypair.generate().publicKey.toBase58();
  assert.equal(
    entriesFromSnapshot(
      {
        version: 1,
        receipts: [
          {
            type: "RunRecord",
            pubkey: "r",
            owner,
            run_index: 1,
            mints: [ANTHROPIC],
            amounts: [1],
            slot: 3,
            ts: 3,
          },
        ],
      },
      owner,
    )[0]?.generation,
    0,
  );
});

test("history cache v2 ignores v1 and incremental refresh uses until", async () => {
  const owner = Keypair.generate().publicKey;
  const program = programId();
  const storage = memoryStorage();
  storage.setItem(historyCacheLegacyKey(owner.toBase58()), "{\"old\":[]}");
  const seen: Array<{ until?: string; before?: string }> = [];
  const connection = {
    async getSignaturesForAddress(_address: PublicKey, options?: { until?: string; before?: string }) {
      seen.push({ until: options?.until, before: options?.before });
      if (options?.until === "old") return [{ signature: "new" }];
      return [{ signature: "old" }];
    },
    async getTransaction(signature: string) {
      return {
        slot: signature === "new" ? 8 : 4,
        meta: { err: null, logMessages: [] },
      };
    },
  };
  const first = await fetchHistoryEvents({
    connection,
    address: owner,
    owner: owner.toBase58(),
    programId: program,
    storage,
    cap: 10,
  });
  assert.equal(storage.getItem(historyCacheLegacyKey(owner.toBase58())), null);
  assert.equal(first.newest, "old");
  assert.match(storage.getItem(historyCacheKey(owner.toBase58())) ?? "", /"entries"/);
  assert.equal(HISTORY_CACHE_PREFIX, "noir.historyEvents.v2");
  const second = await fetchHistoryEvents({
    connection,
    address: owner,
    owner: owner.toBase58(),
    programId: program,
    storage,
    cap: historyIncrementalQuery("old").cap,
    until: historyIncrementalQuery("old").until,
  });
  assert.equal(second.fetched, 1);
  assert.equal(second.newest, "new");
  assert.equal(seen[1]?.until, "old");
  assert.equal(first.fetched, 1);

  const store = {
    getItem: (key: string) => storage.getItem(key),
    setItem: (key: string, value: string) => storage.setItem(key, value),
    removeItem: (key: string) => storage.removeItem?.(key),
    key: (index: number) => [...storage.dump().keys()][index] ?? null,
    get length() {
      return storage.dump().size;
    },
  } as Storage;
  clearClosedOwnerState(store, owner.toBase58());
  assert.equal(store.getItem(historyCacheKey(owner.toBase58())), null);
});

test("history refresh waits for a visible tab and does not overlap", async () => {
  assert.equal(historyRefreshDecision({ visible: false, inFlight: false }), "skip");
  assert.equal(historyRefreshDecision({ visible: true, inFlight: true }), "skip");
  assert.equal(historyRefreshDecision({ visible: true, inFlight: false }), "poll");
  assert.equal(HISTORY_REFRESH_MS, 60_000);
  assert.deepEqual(historyIncrementalQuery(null), { cap: HISTORY_INITIAL_SIGNATURE_CAP });
  assert.deepEqual(historyIncrementalQuery("sig-9"), {
    until: "sig-9",
    cap: HISTORY_INITIAL_SIGNATURE_CAP,
  });

  const queue = createHistoryRefreshQueue();
  const order: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = queue.enqueue(async () => {
    order.push("start1");
    await gate;
    order.push("end1");
  });
  await Promise.resolve();
  assert.equal(queue.inFlight, true);
  const second = queue.enqueue(async () => {
    order.push("start2");
  });
  assert.deepEqual(order, ["start1"]);
  release();
  await first;
  await second;
  assert.deepEqual(order, ["start1", "end1", "start2"]);
  assert.equal(queue.inFlight, false);

  const hook = readFileSync(new URL("../lib/hooks/usePredca.ts", import.meta.url), "utf8");
  assert.match(hook, /HISTORY_REFRESH_MS/);
  assert.match(hook, /historyIncrementalQuery/);
  assert.match(hook, /until: query\.until/);
  assert.match(hook, /historyRefreshDecision/);
  assert.match(hook, /void rememberBuyEvent\(sig\)/);
  const view = readFileSync(new URL("../components/HistoryRunEntry.tsx", import.meta.url), "utf8");
  assert.match(view, /history\.previousAccount/);
  assert.doesNotMatch(view, /keeper/i);
});
