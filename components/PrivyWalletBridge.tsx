"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import type { SendTransactionOptions } from "@solana/wallet-adapter-base";
import {
  useSignMessage,
  useSignTransaction,
  useStandardWallets,
  useWallets,
} from "@privy-io/react-auth/solana";
import type { Wallet } from "@wallet-standard/base";
import {
  Connection,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import { TxNotice } from "@/components/TxNotice";
import { translate, useI18n } from "@/lib/i18n";
import { getLocaleSnapshot } from "@/lib/locale-store";
import { PRIVY_SOLANA_CHAIN, privyAppId } from "@/lib/privy-devnet";
import {
  beginPrivySign,
  endPrivySign,
  getPrivySigningServerSnapshot,
  getPrivySigningSnapshot,
  privySignSuccessUi,
  subscribePrivySigning,
} from "@/lib/privy-sign-ui";
import { PRIVY_WALLET_NAME } from "@/lib/privy-embedded-adapter";
import { registerWallet } from "@/lib/privy-register-wallet";
import {
  serializeTransactionForPrivy,
  signatureBytesFromPrivy,
  signedBytesToTransaction,
} from "@/lib/privy-tx-codec";
import {
  getPrivyWalletDelegate,
  setPrivyWalletDelegate,
} from "@/lib/privy-wallet-delegate";
import { hasForeignSignature } from "@/lib/privy-blockhash";
import {
  commitLatestRef,
  useIsomorphicLayoutEffect,
} from "@/lib/hooks/useLatestRef";

/** One registration per address. Wallet Standard ignores a second copy of the same object. */
const registeredKeys = new Set<string>();

export type PrivySendTransaction = (
  transaction: Transaction | VersionedTransaction,
  connection: Connection,
  options?: SendTransactionOptions,
) => Promise<string>;

export type PrivyTxOverride = {
  anchorWallet: AnchorWallet;
  sendTransaction: PrivySendTransaction;
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
};

const PrivyTxContext = createContext<PrivyTxOverride | null>(null);

/**
 * Wallet-adapter's standard adapter omits `chain` on signTransaction.
 * Privy's standard wallet then defaults that call to solana:mainnet.
 * When the selected wallet is Privy, Anchor and keeper signing use this
 * bridge and pass solana:devnet explicitly.
 */
async function refreshLegacyBlockhash(
  transaction: Transaction,
  connection: Connection,
): Promise<void> {
  const latest = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = latest.blockhash;
  transaction.lastValidBlockHeight = latest.lastValidBlockHeight;
}

function canRefreshLegacyBlockhash(
  transaction: Transaction,
  feePayer: PublicKey,
): boolean {
  return !hasForeignSignature(
    transaction.signatures.map((entry) => ({
      pubkey: entry.publicKey.toBase58(),
      signed: entry.signature != null,
    })),
    feePayer.toBase58(),
  );
}

/** Drop a stale fee-payer signature so the refreshed message is what Privy signs. */
function clearFeePayerSignature(transaction: Transaction, feePayer: PublicKey) {
  for (const entry of transaction.signatures) {
    if (entry.publicKey.equals(feePayer)) entry.signature = null;
  }
}

export function PrivyWalletBridge({ children }: { children: ReactNode }) {
  const { connection } = useConnection();
  const connectionRef = useRef(connection);
  const { wallets: standardWallets } = useStandardWallets();
  const { wallets } = useWallets();
  const { signMessage: privySignMessage } = useSignMessage();
  const { signTransaction: privySignTransaction } = useSignTransaction();
  const { wallet: selected } = useWallet();

  const embedded = useMemo(
    () => wallets.find((w) => w.standardWallet.name === "Privy") ?? null,
    [wallets],
  );

  const embeddedRef = useRef(embedded);
  const signMessageRef = useRef(privySignMessage);
  const signTransactionRef = useRef(privySignTransaction);
  const standardRef = useRef(standardWallets);
  // Before the registration and delegate effects below, and before child
  // useEffect. The ref is created with this render's value, then kept current.
  useIsomorphicLayoutEffect(() => {
    commitLatestRef(connectionRef, connection);
    commitLatestRef(embeddedRef, embedded);
    commitLatestRef(signMessageRef, privySignMessage);
    commitLatestRef(signTransactionRef, privySignTransaction);
    commitLatestRef(standardRef, standardWallets);
  });

  const privyStandard = useMemo(
    () =>
      standardWallets.find(
        (wallet) => wallet.name === "Privy" && "privy:" in wallet.features,
      ) ?? null,
    [standardWallets],
  );
  // Register only once the embedded account exists. An empty "pending"
  // wallet makes standard `connect()` return no account and the UI never
  // leaves "Łączenie…".
  const registerAddress = privyStandard?.accounts[0]?.address ?? "";

  useEffect(() => {
    if (!registerAddress) return;
    // WalletProvider subscribes to register events in an effect. A timeout
    // lets that listener attach before we dispatch, or the wallet is stored
    // and never announced.
    const handle = window.setTimeout(() => {
      const wallet = standardRef.current.find(
        (item) =>
          item.name === "Privy" &&
          "privy:" in item.features &&
          item.accounts[0]?.address === registerAddress,
      );
      if (!wallet) return;
      if (registeredKeys.has(registerAddress)) return;
      registerWallet(wallet as unknown as Wallet);
      registeredKeys.add(registerAddress);
    }, 0);
    return () => window.clearTimeout(handle);
  }, [registerAddress]);

  useEffect(() => {
    const current = embeddedRef.current;
    if (!current) {
      // Logout drops the embedded account. A later reconnect must registerWallet
      // again; a remembered address skips it and the adapter can stall.
      registeredKeys.clear();
      setPrivyWalletDelegate(null);
      return;
    }
    setPrivyWalletDelegate({
      address: current.address,
      signMessage: async (message) => {
        const wallet = embeddedRef.current;
        if (!wallet) throw new Error(translate(getLocaleSnapshot(), "privy.missingWallet"));
        const { signature } = await signMessageRef.current({
          message,
          wallet,
        });
        return signatureBytesFromPrivy(signature);
      },
      signTransactionBytes: async (serialized) => {
        const wallet = embeddedRef.current;
        if (!wallet) throw new Error(translate(getLocaleSnapshot(), "privy.missingWallet"));
        // Success copy only. showWalletUIs stays untouched so Approve remains.
        // Privy resolves this promise when the user closes the success screen.
        beginPrivySign();
        try {
          const { signedTransaction } = await signTransactionRef.current({
            transaction: serialized,
            wallet,
            chain: PRIVY_SOLANA_CHAIN,
            options: {
              uiOptions: privySignSuccessUi(getLocaleSnapshot()),
            },
          });
          if (
            !(signedTransaction instanceof Uint8Array) ||
            signedTransaction.byteLength === 0
          ) {
            throw new Error(translate(getLocaleSnapshot(), "privy.noSignedTx"));
          }
          return signedTransaction;
        } finally {
          endPrivySign();
        }
      },
    });
    return () => setPrivyWalletDelegate(null);
  }, [embedded?.address]);

  const selectedAddress = selected?.adapter.publicKey?.toBase58() ?? null;
  const privySelected = selected?.adapter.name === PRIVY_WALLET_NAME;
  const address =
    privySelected && embedded && embedded.address === selectedAddress
      ? embedded.address
      : null;

  const override = useMemo<PrivyTxOverride | null>(() => {
    if (!address) return null;
    const publicKey = new PublicKey(address);

    async function requireDelegate() {
      const delegate = getPrivyWalletDelegate();
      if (!delegate || delegate.address !== publicKey.toBase58()) {
        throw new Error(translate(getLocaleSnapshot(), "privy.notReadyToSign"));
      }
      return delegate;
    }

    const anchorWallet: AnchorWallet = {
      publicKey,
      async signTransaction(transaction) {
        const delegate = await requireDelegate();
        // Anchor `.rpc()` and ensureOwnerAtas set the blockhash before the
        // user sees Privy. Refresh it here, immediately before the prompt,
        // unless another signer already signed (a new hash would break them).
        if (
          transaction instanceof Transaction &&
          canRefreshLegacyBlockhash(transaction, publicKey)
        ) {
          clearFeePayerSignature(transaction, publicKey);
          await refreshLegacyBlockhash(transaction, connectionRef.current);
        }
        const signed = await delegate.signTransactionBytes(
          serializeTransactionForPrivy(transaction),
        );
        return signedBytesToTransaction(transaction, signed, publicKey);
      },
      async signAllTransactions(transactions) {
        const signed = [];
        for (const transaction of transactions) {
          signed.push(await anchorWallet.signTransaction(transaction));
        }
        return signed;
      },
    };

    const sendTransaction: PrivySendTransaction = async (
      transaction,
      connection,
      options,
    ) => {
      const { signers, ...sendOptions } = options ?? {};
      if (transaction instanceof VersionedTransaction) {
        if (signers?.length) transaction.sign(signers);
      } else {
        if (!transaction.feePayer) transaction.feePayer = publicKey;
        if (canRefreshLegacyBlockhash(transaction, publicKey)) {
          clearFeePayerSignature(transaction, publicKey);
          await refreshLegacyBlockhash(transaction, connection);
        }
        if (signers?.length) transaction.partialSign(...signers);
      }
      const signedTx = await anchorWallet.signTransaction(transaction);
      const raw = signedTx.serialize();
      return connection.sendRawTransaction(
        raw instanceof Uint8Array ? raw : new Uint8Array(raw),
        sendOptions,
      );
    };

    return {
      anchorWallet,
      sendTransaction,
      signMessage: async (message) => {
        const delegate = await requireDelegate();
        return delegate.signMessage(message);
      },
    };
  }, [address]);

  return (
    <PrivyTxContext.Provider value={override}>{children}</PrivyTxContext.Provider>
  );
}

export function usePrivyTxOverride(): PrivyTxOverride | null {
  return useContext(PrivyTxContext);
}

/** Keeper signatures. Phantom and Solflare keep useWallet().signMessage. */
export function useKeeperSignMessage():
  | ((message: Uint8Array) => Promise<Uint8Array>)
  | undefined {
  const { signMessage, wallet } = useWallet();
  const privy = useContext(PrivyTxContext);
  if (wallet?.adapter.name === PRIVY_WALLET_NAME && privy?.signMessage) {
    return privy.signMessage;
  }
  return signMessage;
}

export function privyWalletEnabled(): boolean {
  return privyAppId().length > 0;
}

/** Pending line while Privy is still holding the signature. */
export function PrivySignWaitNotice({ className = "" }: { className?: string }) {
  const signing = useSyncExternalStore(
    subscribePrivySigning,
    getPrivySigningSnapshot,
    getPrivySigningServerSnapshot,
  );
  const { t } = useI18n();
  if (!signing) return null;
  return (
    <TxNotice message={t("privy.signWait")} tone="pending" className={className} />
  );
}
