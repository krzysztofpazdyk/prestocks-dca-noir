import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { utils } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import idl from "../idl/predca.json";
import { APP_VERSION } from "../lib/app-version";
import { outsideAppBadgeText } from "../lib/outside-app-badge";
import { setNumberLocaleForTests } from "../lib/number-format";
import { DUST } from "../lib/position-value";
import { programId, runRecordPda } from "../lib/predca";
import {
  classifyBuyDiscriminator,
  classifyBuyDiscriminators,
  classifyRunTransaction,
  historyRunMetaText,
  loadRunOrigin,
  oldestSignature,
  originsFromSnapshot,
  readRunOriginCache,
  readRunOriginSnapshot,
  runOriginStorageKey,
  subscribeRunOriginCache,
  writeRunOriginCache,
  type OriginConnection,
  type OriginTransaction,
} from "../lib/run-origin";

const EXECUTE_BUY = [14, 137, 248, 5, 172, 244, 183, 152];
const EXECUTE_BUY_V2 = [75, 39, 221, 15, 224, 141, 61, 134];
const SIMULATE_BUY = [114, 119, 83, 45, 3, 11, 107, 77];
const SIMULATE_BUY_V2 = [89, 30, 168, 24, 97, 40, 67, 118];
const RECORD_RUN = [203, 171, 212, 47, 170, 30, 0, 146];

const KNOWN: Record<string, number[]> = {
  execute_buy: EXECUTE_BUY,
  execute_buy_v2: EXECUTE_BUY_V2,
  simulate_buy: SIMULATE_BUY,
  simulate_buy_v2: SIMULATE_BUY_V2,
  record_run: RECORD_RUN,
};

function disc(name: string): Uint8Array {
  const ix = idl.instructions.find((row) => row.name === name);
  assert.ok(ix, name);
  return Uint8Array.from(ix.discriminator);
}

function key(address: string): { toBase58(): string } {
  return { toBase58: () => address };
}

function txOf(
  program: string,
  datas: Array<Uint8Array | string>,
  where: "outer" | "inner" | "loaded",
): OriginTransaction {
  const system = "11111111111111111111111111111111";
  const ixs = datas.map((data) => ({
    programIdIndex: 1,
    data,
  }));
  const staticKeys =
    where === "loaded" ? [key(system)] : [key(system), key(program)];
  return {
    transaction: {
      message: {
        staticAccountKeys: staticKeys,
        compiledInstructions: where === "inner" ? [] : ixs,
      },
    },
    meta:
      where === "inner"
        ? { innerInstructions: [{ instructions: ixs }] }
        : where === "loaded"
          ? { loadedAddresses: { writable: [key(program)], readonly: [] } }
          : null,
  };
}

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    setItem: (k, v) => {
      data.set(k, String(v));
    },
    removeItem: (k) => {
      data.delete(k);
    },
    clear: () => data.clear(),
    key: (index) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  };
}

test("buy discriminators classify execute as auto and simulate or record_run as manual", () => {
  for (const [name, bytes] of Object.entries(KNOWN)) {
    assert.deepEqual([...disc(name)], bytes, name);
  }
  assert.equal(classifyBuyDiscriminator(disc("execute_buy")), "auto");
  assert.equal(classifyBuyDiscriminator(disc("execute_buy_v2")), "auto");
  assert.equal(classifyBuyDiscriminator(disc("simulate_buy")), "manual");
  assert.equal(classifyBuyDiscriminator(disc("simulate_buy_v2")), "manual");
  assert.equal(classifyBuyDiscriminator(disc("record_run")), "manual");

  const withArgs = Uint8Array.from([...SIMULATE_BUY_V2, 1, 2, 3, 4]);
  assert.equal(classifyBuyDiscriminator(withArgs), "manual");
  assert.equal(classifyBuyDiscriminator(Uint8Array.from(EXECUTE_BUY_V2.slice(0, 7))), null);
  assert.equal(classifyBuyDiscriminator(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])), null);
  assert.equal(classifyBuyDiscriminator(disc("deposit_usdc")), null);

  for (const ix of idl.instructions) {
    const expected = ix.name.startsWith("execute_buy")
      ? "auto"
      : ix.name.startsWith("simulate_buy") || ix.name === "record_run"
        ? "manual"
        : null;
    assert.equal(classifyBuyDiscriminator(Uint8Array.from(ix.discriminator)), expected, ix.name);
  }

  assert.equal(
    classifyBuyDiscriminators([disc("record_run"), disc("execute_buy_v2")]),
    "auto",
  );
  assert.equal(classifyBuyDiscriminators([disc("simulate_buy"), disc("record_run")]), "manual");
  assert.equal(classifyBuyDiscriminators([disc("deposit_usdc")]), null);
});

test("a run transaction is classified only from Predca instructions", () => {
  const program = programId().toBase58();
  assert.equal(
    classifyRunTransaction(txOf(program, [disc("execute_buy_v2")], "outer"), program),
    "auto",
  );
  assert.equal(
    classifyRunTransaction(txOf(program, [disc("simulate_buy_v2")], "outer"), program),
    "manual",
  );
  const encoded = utils.bytes.bs58.encode(Uint8Array.from([...RECORD_RUN, 7]));
  assert.equal(typeof encoded, "string");
  assert.equal(
    classifyRunTransaction(txOf(program, [encoded], "inner"), program),
    "manual",
  );
  assert.equal(
    classifyRunTransaction(txOf(program, [disc("execute_buy")], "loaded"), program),
    "auto",
  );
  assert.equal(
    classifyRunTransaction(txOf(program, [disc("execute_buy_v2")], "outer"), PublicKey.unique().toBase58()),
    null,
  );
  assert.equal(
    classifyRunTransaction(
      txOf(program, [disc("record_run"), disc("execute_buy")], "outer"),
      program,
    ),
    "auto",
  );
});

test("history line appends auto or manual and stays bare when the origin is unknown", () => {
  const plAuto = historyRunMetaText({
    locale: "pl",
    index: "0",
    slot: "512789359",
    budgetText: "$150,00",
    origin: "auto",
  });
  const plManual = historyRunMetaText({
    locale: "pl",
    index: "0",
    slot: "512789359",
    budgetText: "$150,00",
    origin: "manual",
  });
  const plBare = historyRunMetaText({
    locale: "pl",
    index: "0",
    slot: "512789359",
    budgetText: "$150,00",
    origin: null,
  });
  assert.equal(plAuto, "Run #0 · budżet ~$150,00 · slot 512789359 · auto");
  assert.equal(plManual, "Run #0 · budżet ~$150,00 · slot 512789359 · ręczny");
  assert.equal(plBare, "Run #0 · budżet ~$150,00 · slot 512789359");
  assert.equal(plBare.includes("?"), false);
  assert.equal(plBare.includes("auto"), false);
  assert.equal(plBare.includes("ręczny"), false);

  assert.equal(
    historyRunMetaText({
      locale: "en",
      index: "0",
      slot: "512789359",
      budgetText: "$150.00",
      origin: "manual",
    }),
    "Run #0 · budget ~$150.00 · slot 512789359 · manual",
  );
  assert.equal(
    historyRunMetaText({
      locale: "en",
      index: "0",
      slot: "512789359",
      budgetText: "$150.00",
      origin: "auto",
    }),
    "Run #0 · budget ~$150.00 · slot 512789359 · auto",
  );
  assert.equal(
    historyRunMetaText({
      locale: "en",
      index: "0",
      slot: "512789359",
      budgetText: "$150.00",
      origin: null,
    }),
    "Run #0 · budget ~$150.00 · slot 512789359",
  );
  assert.equal(
    historyRunMetaText({
      locale: "pl",
      index: "3",
      slot: "9",
      budgetText: null,
      origin: "manual",
    }),
    "Run #3 · budżet — · slot 9 · ręczny",
  );
  assert.equal(
    historyRunMetaText({
      locale: "en",
      index: "3",
      slot: "9",
      budgetText: null,
      origin: null,
    }),
    "Run #3 · budget — · slot 9",
  );
});

test("oldest signature is the last entry of the last short page", async () => {
  const full = Array.from({ length: 1000 }, (_, i) => ({ signature: `p1-${i}` }));
  const befores: Array<string | undefined> = [];
  const pages = [full, [{ signature: "older" }, { signature: "oldest" }]];
  let call = 0;
  const oldest = await oldestSignature(async (before) => {
    befores.push(before);
    return pages[call++] ?? [];
  });
  assert.equal(oldest, "oldest");
  assert.deepEqual(befores, [undefined, "p1-999"]);
  assert.equal(await oldestSignature(async () => [{ signature: "only" }]), "only");
  assert.equal(await oldestSignature(async () => []), null);
});

test("loadRunOrigin reads the run PDA and does not label an RPC failure", async () => {
  const owner = PublicKey.unique();
  const [pda] = runRecordPda(owner, 4);
  const program = programId().toBase58();
  const seen = {
    asked: "" as string,
    commitment: "" as string,
    version: -1,
    limit: -1,
  };
  const connection: OriginConnection = {
    async getSignaturesForAddress(address, options) {
      seen.asked = address.toBase58();
      seen.limit = options?.limit ?? -1;
      return [{ signature: "newer" }, { signature: "oldest-sig" }];
    },
    async getTransaction(signature, options) {
      assert.equal(signature, "oldest-sig");
      seen.commitment = options?.commitment ?? "";
      seen.version = options?.maxSupportedTransactionVersion ?? -1;
      return txOf(program, [disc("simulate_buy_v2")], "outer");
    },
  };
  const ok = await loadRunOrigin(connection, owner, "4");
  assert.equal(seen.asked, pda.toBase58());
  assert.equal(seen.limit, 1000);
  assert.equal(seen.commitment, "confirmed");
  assert.equal(seen.version, 0);
  assert.deepEqual(ok, { ok: true, origin: "manual" });

  const broken: OriginConnection = {
    async getSignaturesForAddress() {
      throw new Error("rpc down");
    },
    async getTransaction() {
      return null;
    },
  };
  assert.deepEqual(await loadRunOrigin(broken, owner, 4), { ok: false });

  const missingTx: OriginConnection = {
    async getSignaturesForAddress() {
      return [{ signature: "sig" }];
    },
    async getTransaction() {
      return null;
    },
  };
  assert.deepEqual(await loadRunOrigin(missingTx, owner, 4), { ok: false });

  const unlabeled: OriginConnection = {
    async getSignaturesForAddress() {
      return [{ signature: "sig" }];
    },
    async getTransaction() {
      return txOf(program, [disc("deposit_usdc")], "outer");
    },
  };
  assert.deepEqual(await loadRunOrigin(unlabeled, owner, 4), { ok: true, origin: null });
});

test("run origin cache keeps auto or manual per owner and run index", () => {
  const storage = memoryStorage();
  const owner = PublicKey.unique().toBase58();
  assert.equal(readRunOriginCache(storage, owner, "0"), null);
  writeRunOriginCache(storage, owner, "0", "auto");
  writeRunOriginCache(storage, owner, "1", "manual");
  assert.equal(readRunOriginCache(storage, owner, "0"), "auto");
  assert.equal(readRunOriginCache(storage, owner, "1"), "manual");
  assert.equal(readRunOriginCache(storage, owner, "2"), null);
  assert.equal(storage.getItem(runOriginStorageKey(owner, "0")), "auto");
  storage.setItem(runOriginStorageKey(owner, "9"), "maybe");
  assert.equal(readRunOriginCache(storage, owner, "9"), null);
  const other = PublicKey.unique().toBase58();
  assert.equal(readRunOriginCache(storage, other, "0"), null);

  const throwing = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("denied");
    },
  } as unknown as Storage;
  assert.equal(readRunOriginCache(throwing, owner, "0"), null);
  writeRunOriginCache(throwing, owner, "0", "auto");

  assert.deepEqual(originsFromSnapshot("0=auto,1=manual,2=nope,"), {
    "0": "auto",
    "1": "manual",
  });
  assert.deepEqual(originsFromSnapshot(""), {});

  const previous = globalThis.localStorage;
  globalThis.localStorage = storage;
  let notices = 0;
  const stop = subscribeRunOriginCache(() => {
    notices += 1;
  });
  try {
    assert.equal(readRunOriginSnapshot(owner, "0,1,2"), "0=auto,1=manual");
    writeRunOriginCache(storage, owner, "0", "auto");
    assert.equal(notices, 0);
    writeRunOriginCache(storage, owner, "2", "manual");
    assert.equal(notices, 1);
    assert.equal(readRunOriginSnapshot(owner, "2,0"), "2=manual,0=auto");
  } finally {
    stop();
    if (previous === undefined) {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    } else {
      globalThis.localStorage = previous;
    }
  }
});

test("outside-app badge shows the unit count and is absent at zero", () => {
  setNumberLocaleForTests("pl-PL");
  try {
    assert.equal(outsideAppBadgeText(1, "pl"), "w tym 1,0 spoza aplikacji");
    assert.equal(outsideAppBadgeText(1.25, "pl"), "w tym 1,25 spoza aplikacji");
    assert.equal(outsideAppBadgeText(1, "en"), "incl. 1,0 outside the app");
  } finally {
    setNumberLocaleForTests(null);
  }
  setNumberLocaleForTests("en-US");
  try {
    assert.equal(outsideAppBadgeText(1, "en"), "incl. 1.0 outside the app");
    assert.equal(outsideAppBadgeText(1, "pl"), "w tym 1.0 spoza aplikacji");
  } finally {
    setNumberLocaleForTests(null);
  }
  assert.equal(outsideAppBadgeText(0, "pl"), null);
  assert.equal(outsideAppBadgeText(0, "en"), null);
  assert.equal(outsideAppBadgeText(DUST, "pl"), null);
  assert.equal(outsideAppBadgeText(-2, "en"), null);
  assert.equal(outsideAppBadgeText(Number.NaN, "pl"), null);

  const overview = readFileSync(
    new URL("../components/OverviewView.tsx", import.meta.url),
    "utf8",
  );
  assert.match(overview, /outsideAppBadgeText\(outsideUnits, locale\)/);
  assert.match(overview, /\{outsideBadge && \(\s*<Badge title=\{outsideBadge\}>\{outsideBadge\}<\/Badge>/);
  assert.doesNotMatch(overview, /t\("positions\.outsideApp"\)/);
  const pnlFn = overview.slice(
    overview.indexOf("function PnlSection"),
    overview.indexOf("function PositionsCard"),
  );
  assert.match(pnlFn, /v\{APP_VERSION\}/);
  assert.equal(APP_VERSION, "5.0.23");

  const entry = readFileSync(
    new URL("../components/HistoryRunEntry.tsx", import.meta.url),
    "utf8",
  );
  const history = readFileSync(
    new URL("../components/HistoryView.tsx", import.meta.url),
    "utf8",
  );
  assert.match(entry, /historyRunMetaText\(/);
  assert.match(entry, /origin,/);
  assert.match(history, /useSyncExternalStore/);
  assert.match(history, /loadRunOrigin\(connection, owner, index\)/);
  assert.match(history, /if \(!result\.ok \|\| !result\.origin\) return;/);
  assert.match(history, /writeRunOriginCache\(/);
  assert.match(history, /origin=\{origins\[run\.runIndex\.toString\(\)\] \?\? null\}/);
  assert.doesNotMatch(entry, /· \?/);
});
