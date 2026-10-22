import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  SignatureNotConfirmedError,
  assembleBuyTransaction,
  ataCreateInstructions,
  chooseBuySubmit,
  classifySignatureRow,
  confirmSignatureByPolling,
  legacyPacketBytes,
  missingAtaIndexes,
  ownerAtaAddress,
  SIGNATURE_POLL_INTERVAL_MS,
  SIGNATURE_POLL_TIMEOUT_MS,
} from "../lib/buy-ata";
import { translate } from "../lib/i18n";
import {
  MOCK_USDC_MINT,
  getProgram,
  priceFeedPda,
  programId,
  runPricePda,
} from "../lib/predca";
import { isStaleBlockhashError } from "../lib/privy-blockhash";
import { isUnconfirmedTimeout } from "../lib/vault-follow-up";

const SIG = "1".repeat(88);

function blockhash(): string {
  return Keypair.generate().publicKey.toBase58();
}

test("missing ATA indexes keep only the absent accounts, in order", () => {
  assert.deepEqual(missingAtaIndexes([true, true, true]), []);
  assert.deepEqual(missingAtaIndexes([false, true, false]), [0, 2]);
  assert.deepEqual(missingAtaIndexes([false, false, false]), [0, 1, 2]);
});

test("ATA instructions are only the missing ones and stay in front of the buy", () => {
  const owner = Keypair.generate().publicKey;
  const mints = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];
  const buy = new TransactionInstruction({
    programId: programId(),
    keys: [],
    data: Buffer.alloc(0),
  });
  const none = ataCreateInstructions(owner, mints, []);
  assert.equal(none.length, 0);
  const onlySecond = ataCreateInstructions(owner, mints, [1]);
  assert.equal(onlySecond.length, 1);
  assert.equal(onlySecond[0].programId.toBase58(), ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
  assert.equal(
    onlySecond[0].keys.some((key) => key.pubkey.equals(mints[1])),
    true,
  );
  assert.equal(
    onlySecond[0].keys.some((key) => key.pubkey.equals(mints[0]) || key.pubkey.equals(mints[2])),
    false,
  );
  const tx = assembleBuyTransaction(onlySecond, buy, owner, blockhash());
  assert.equal(tx.instructions.length, 2);
  assert.equal(tx.instructions[0].programId.toBase58(), ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
  assert.equal(tx.instructions[1].programId.toBase58(), programId().toBase58());
  assert.equal(tx.feePayer?.toBase58(), owner.toBase58());
});

test("polling confirms, rejects a failed signature, and times out", async () => {
  let reads = 0;
  await confirmSignatureByPolling(
    async () => {
      reads += 1;
      if (reads === 1) return [null];
      return [{ err: null, confirmationStatus: "confirmed" }];
    },
    SIG,
    { sleep: async () => {}, now: () => 0 },
  );
  assert.equal(reads, 2);

  await assert.rejects(
    () =>
      confirmSignatureByPolling(
        async () => [{ err: { InstructionError: [0, "Custom"] }, confirmationStatus: null }],
        SIG,
        { sleep: async () => {}, now: () => 0 },
      ),
    /Transakcja odrzucona przez Devnet/,
  );

  let now = 0;
  let sleeps = 0;
  await assert.rejects(
    () =>
      confirmSignatureByPolling(async () => [null], SIG, {
        timeoutMs: 3000,
        intervalMs: 1500,
        now: () => now,
        sleep: async (ms) => {
          sleeps += 1;
          now += ms;
        },
      }),
    (err: unknown) => {
      assert.equal(err instanceof SignatureNotConfirmedError, true);
      assert.equal(isUnconfirmedTimeout(err)?.signature, SIG);
      assert.equal(isStaleBlockhashError(err), false);
      return true;
    },
  );
  assert.equal(sleeps, 2);
  assert.equal(now, 3000);
});

test("a token-account timeout is not treated as an unconfirmed purchase", () => {
  const pl = translate("pl", "buy.ataUnconfirmedNoBuy");
  const en = translate("en", "buy.ataUnconfirmedNoBuy");
  for (const text of [pl, en, `${pl} ${SIG}`]) {
    const err = new Error(text);
    assert.equal(isUnconfirmedTimeout(err), null);
    assert.equal(isStaleBlockhashError(err), false);
  }
  assert.equal(translate("pl", "buy.stepAta"), "Krok 1/2: tworzę konta tokenów (podpis)");
  assert.equal(translate("en", "buy.stepAta"), "Step 1/2: creating token accounts (signature)");
  assert.equal(translate("pl", "buy.stepBuy"), "Krok 2/2: zakup (podpis)");
  assert.equal(translate("en", "buy.stepBuy"), "Step 2/2: purchase (signature)");
  assert.match(translate("pl", "buy.ataCreatedNoVault"), /nie zostały ruszone/);
  assert.match(translate("en", "buy.ataCreatedNoVault"), /not touched/);
  assert.equal(SIGNATURE_POLL_INTERVAL_MS, 1500);
  assert.equal(SIGNATURE_POLL_TIMEOUT_MS, 60_000);
  assert.equal(classifySignatureRow({ err: null, confirmationStatus: "processed" }), "pending");
  assert.equal(classifySignatureRow({ err: null, confirmationStatus: "finalized" }), "confirmed");
});

test("three missing ATAs plus simulateBuyV2 fit in one legacy transaction", async () => {
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
  const mints = [
    Keypair.generate().publicKey,
    Keypair.generate().publicKey,
    Keypair.generate().publicKey,
  ];
  const usdc = new PublicKey(MOCK_USDC_MINT);
  const ix = await program.methods
    .simulateBuyV2(new BN(0), mints, Array.from({ length: 32 }, () => 0))
    .accounts({
      usdcMint: usdc,
      mintA: mints[0],
      mintB: mints[1],
      mintC: mints[2],
      priceFeedA: priceFeedPda(mints[0])[0],
      priceFeedB: priceFeedPda(mints[1])[0],
      priceFeedC: priceFeedPda(mints[2])[0],
      runPrice: runPricePda(owner.publicKey, 0)[0],
    })
    .instruction();
  const ataIxs = ataCreateInstructions(owner.publicKey, mints, [0, 1, 2]);
  assert.equal(ataIxs.length, 3);
  for (let i = 0; i < 3; i++) {
    assert.equal(
      ataIxs[i].keys.some((key) => key.pubkey.equals(ownerAtaAddress(owner.publicKey, mints[i]))),
      true,
    );
  }
  const tx = assembleBuyTransaction(ataIxs, ix, owner.publicKey, blockhash());
  assert.equal(tx.instructions.length, 4);
  assert.equal(tx.instructions[0].programId.toBase58(), ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
  assert.equal(tx.instructions[3].programId.toBase58(), programId().toBase58());
  const bytes = legacyPacketBytes(tx);
  assert.equal(bytes <= 1232, true, `combined buy is ${bytes} bytes`);
  assert.equal(chooseBuySubmit(3, bytes), "combined");
  assert.equal(chooseBuySubmit(0, bytes), "buy-only");
  assert.equal(chooseBuySubmit(3, 1233), "two-step");
});

test("the purchase hook no longer confirms token accounts with a websocket", () => {
  const hook = readFileSync(new URL("../lib/hooks/usePredca.ts", import.meta.url), "utf8");
  const buy = hook.slice(hook.indexOf("const submitAt"), hook.indexOf("const submitOnce"));
  assert.doesNotMatch(buy, /confirmTransaction\(/);
  assert.match(buy, /confirmSignatureByPolling/);
  assert.match(buy, /chooseBuySubmit/);
  assert.match(buy, /buy\.stepAta/);
  assert.match(buy, /buy\.stepBuy/);
  assert.match(buy, /buy\.ataCreatedNoVault/);
  assert.match(buy, /buy\.ataUnconfirmedNoBuy/);
  assert.match(hook, /\.rpc\(\)/);
});
