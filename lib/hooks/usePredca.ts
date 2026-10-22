"use client";

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AnchorProvider } from "@coral-xyz/anchor";
import { useConnection, useAnchorWallet, useWallet } from "@solana/wallet-adapter-react";
import { usePrivyTxOverride } from "@/components/PrivyWalletBridge";
import { PRIVY_WALLET_NAME } from "@/lib/privy-embedded-adapter";
import {
  isStaleBlockhashError,
  withOneStaleBlockhashRetry,
} from "@/lib/privy-blockhash";
import {
  leaveManualBuy,
  noteUnconfirmedRunIndex,
  recoverRunCollision,
  tryEnterManualBuy,
} from "@/lib/manual-buy-guard";
import {
  CHAIN_POLL_MS,
  buyRefreshSettled,
  chainPollDecision,
  commitRefreshRead,
  postTxReadAttempt,
  refreshCallDecision,
  loadJupPricesInBackground,
  refreshPrices as refreshPricesOnly,
  refreshWriteStillCurrent,
  retryRefresh,
  vaultMoved,
} from "@/lib/predca-refresh";
import {
  EMPTY_SNAPSHOT,
  rpcReadErrorMessage,
  depositPlan,
  derivePredcaStatus,
  type PredcaSnapshot,
  type PredcaStatus,
} from "@/lib/predca-status";
import {
  FAILED_EXPIRED_MSG,
  UNRESOLVED_POLL_MAX_MS,
  UNRESOLVED_POLL_MS,
  checkPendingOnce,
  expiryFromHeight,
  isBlockheightExpiredError,
  pendingLockHeld,
  readPendingRecords,
  removePendingRecord,
  sameActionFamily,
  signatureStatusDeps,
  visibleUnresolved,
  writePendingRecord,
  DUPLICATE_GUARD_KINDS,
  type PendingTxKind,
  type PendingTxRecord,
  type PendingVerdict,
  type StorageLike,
} from "@/lib/pending-tx";
import {
  CONFIRMED_VAULT_BACKGROUND_POLL_MS,
  POST_CONFIRM_VAULT_POLL_MS,
  UNRESOLVED_WATCH_MS,
  UNRESOLVED_WATCH_POLL_MS,
  isOnChainSignatureReject,
  isUnconfirmedTimeout,
  outcomeAfterVaultCheck,
  clearDropsPending,
  pendingTxMessage,
  rejectedTxMessage,
  unresolvedSignatureBlocksTx,
} from "@/lib/vault-follow-up";
import {
  Transaction,
  type PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  assembleBuyTransaction,
  ataCreateInstructions,
  chooseBuySubmit,
  confirmSignatureByPolling,
  legacyPacketBytes,
  missingAtaIndexes,
  ownerAtaAddress,
  transactionFromInstructions,
  withOneNetworkRetry,
} from "@/lib/buy-ata";
import { getLocaleSnapshot, type Locale } from "@/lib/locale-store";
import { formatCount, shown, translate } from "@/lib/i18n";
import { formatDollars } from "@/lib/number-format";
import { privySendFailureMessage } from "@/lib/privy-sign-ui";
import { fetchJupPrices, emptyJupPrices, type JupPrices } from "@/lib/jup-prices";
import {
  fetchPriceFeedsCached,
  mintedBaseUnits,
  usdPerToken,
  wholeTokensFromBase,
} from "@/lib/price-feed";
import {
  buildPositions,
  portfolioUsdForWallet,
  runLots,
  valueWeights,
  type RunLotSource,
} from "@/lib/position-value";
import { fillsFor, type RunFillView } from "@/lib/run-fills";
import {
  effectiveRunPricePresence,
  fetchRunPrices,
  type DecodedRunPrice,
  type RunPricePresence,
} from "@/lib/run-price";
import type { Holding } from "@/lib/mock-data";
import {
  allMockMints,
  holdingColor,
  resolveTop3Mints,
} from "@/lib/devnet-mock-mints";
import { mintLabel } from "@/lib/mint-label";
import {
  BN,
  MOCK_USDC_MINT,
  dollarsToRaw,
  fetchMockTokenBalances,
  fetchOwnerUsdcBalance,
  fetchRunRecords,
  fetchSolBalance,
  fetchUserConfig,
  explorerTxUrl,
  fetchVaultBalance,
  findNextRunIndex,
  readVaultOrNull,
  formatTs,
  getProgram,
  isRunAlreadyExists,
  resolveVaultBalanceForBuy,
  ownerUsdcAta,
  parseAnchorError,
  priceFeedPda,
  rawToDollars,
  runPricePda,
  usdcMintOrNull,
  type RunRecordData,
  type TokenBalanceRead,
} from "@/lib/predca";
import {
  isRpcTimeout,
  readTimeoutMs,
  refreshDeadline,
  withTimeout,
} from "@/lib/rpc-timeout";

export type { PredcaStatus } from "@/lib/predca-status";

export type OnChainLastPurchase = {
  date: string;
  amountUsd: number;
  tokens: string[];
  perTokenUsd: number;
  /** Minted token amounts (RunRecord.amounts / 1e6). */
  tokenAmounts: number[];
  runIndex: number;
  ts: number;
  /** False when RunPrice is unknown — do not show token units as dollars. */
  priceKnown: boolean;
};

type RefreshCommit = {
  snapshot: PredcaSnapshot;
  prices: Map<number, DecodedRunPrice | null>;
  /** This pass timed out and kept the previous snapshot. Not a settled read. */
  softTimeout?: boolean;
};

export type BuyPreviewLeg = {
  name: string;
  tokens: number;
  priceUsd: number;
};

function mintHint(): string {
  return usdcMintOrNull()?.toBase58() ?? MOCK_USDC_MINT;
}

function bnNum(v: BN | number | { toNumber?: () => number }): number {
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && typeof v.toNumber === "function") {
    return v.toNumber();
  }
  return Number(v);
}

export type { RunFillView };

function runSources(runs: RunRecordData[]): RunLotSource[] {
  return runs.map((run) => ({
    runIndex: bnNum(run.runIndex),
    ts: bnNum(run.ts),
    mints: run.mints.map((m) => (typeof m === "string" ? m : m.toBase58())),
    amountsUsd: run.amounts.map((a) => rawToDollars(a)),
  }));
}

function runToLastPurchase(
  run: RunRecordData,
  presence: RunPricePresence,
  dec: DecodedRunPrice | null,
): OnChainLastPurchase {
  const tokenAmounts = run.amounts.map((a) => rawToDollars(a));
  const tokens = run.mints.map((m) => mintLabel(m));
  const ts =
    typeof run.ts === "object" && run.ts !== null && "toNumber" in run.ts
      ? (run.ts as BN).toNumber()
      : Number(run.ts);
  const runIndex =
    typeof run.runIndex === "object" &&
    run.runIndex !== null &&
    "toNumber" in run.runIndex
      ? (run.runIndex as BN).toNumber()
      : Number(run.runIndex ?? 0);
  const priceKnown = presence !== "unknown";
  const spent =
    priceKnown && dec && dec.usdcSpentEach > BigInt(0)
      ? Number(dec.usdcSpentEach) / 1e6
      : null;
  const amountUsd = !priceKnown
    ? 0
    : spent != null
      ? spent * Math.max(tokenAmounts.length, 1)
      : tokenAmounts.reduce((sum, amount) => sum + amount, 0);
  const perTokenUsd = !priceKnown
    ? 0
    : spent != null
      ? spent
      : tokens.length > 0
        ? amountUsd / tokens.length
        : 0;
  return {
    date: formatTs(run.ts),
    amountUsd,
    tokens,
    perTokenUsd,
    tokenAmounts,
    runIndex,
    ts,
    priceKnown,
  };
}

function rpcReadFailure(e: unknown): string {
  const detail = parseAnchorError(e).replace(/\s+/g, " ").trim().slice(0, 120);
  const base = rpcReadErrorMessage();
  return detail ? `${base} [${detail}]` : base;
}

/** Mark a sibling read as handled. A later await still receives the rejection. */
function markHandled(p: Promise<unknown>): void {
  void p.catch(() => {});
}

function pendingKindLabel(locale: Locale, kind: PendingTxKind): string {
  switch (kind) {
    case "deposit":
    case "init_deposit":
      return translate(locale, "dup.action.deposit");
    case "withdraw":
      return translate(locale, "dup.action.withdraw");
    case "buy":
      return translate(locale, "dup.action.buy");
    case "budget":
      return translate(locale, "tx.kind.budget");
  }
}

function priorSessionOk(rec: PendingTxRecord): string {
  const locale = getLocaleSnapshot();
  const short = `${rec.signature.slice(0, 4)}…${rec.signature.slice(-4)}`;
  const tail =
    rec.amountUsd != null
      ? `${formatDollars(rec.amountUsd)} · ${short}`
      : short;
  return translate(locale, "tx.priorSession", {
    kind: pendingKindLabel(locale, rec.kind),
    tail,
  });
}

function txAmount(locale: Locale, amount: number, digits?: number): string {
  return formatCount(
    locale,
    amount,
    digits == null ? undefined : { min: digits, max: digits },
  );
}

function successForRecord(rec: PendingTxRecord): string {
  const locale = getLocaleSnapshot();
  const amt = rec.amountUsd ?? 0;
  switch (rec.kind) {
    case "init_deposit":
      return translate(locale, "tx.ok.initDeposit", { amount: txAmount(locale, amt) });
    case "deposit":
      return translate(locale, "tx.ok.deposit", { amount: txAmount(locale, amt) });
    case "withdraw":
      return translate(locale, "tx.ok.withdraw", { amount: txAmount(locale, amt) });
    case "budget":
      return translate(locale, "tx.ok.budget");
    case "buy":
      return rec.amountUsd != null
        ? translate(locale, "tx.ok.buyConfirmed", {
            amount: txAmount(locale, rec.amountUsd, 2),
          })
        : translate(locale, "tx.ok.buyConfirmedShort");
  }
}

function browserStorage(): StorageLike | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function privySendNotReady(): Promise<string> {
  return Promise.reject(new Error(shown("privy.signNotReady")));
}

function usePredcaImpl() {
  const { connection } = useConnection();
  const adapterWallet = useAnchorWallet();
  const { sendTransaction: adapterSend, wallet: selectedWallet } = useWallet();
  const privyTx = usePrivyTxOverride();
  const isPrivy = selectedWallet?.adapter.name === PRIVY_WALLET_NAME;
  // Privy's Wallet Standard signTransaction defaults to mainnet when chain is
  // omitted. The bridge passes solana:devnet. Do not fall through to the adapter.
  const wallet = isPrivy ? (privyTx?.anchorWallet ?? null) : adapterWallet;
  const sendTransaction = isPrivy
    ? (privyTx?.sendTransaction ?? privySendNotReady)
    : adapterSend;
  const mint = useMemo(() => usdcMintOrNull(), []);

  const [snapshot, setSnapshot] = useState<PredcaSnapshot>(EMPTY_SNAPSHOT);
  const {
    config,
    configState,
    vaultUsdc,
    ownerUsdc,
    solBalance,
    tokenBalances,
    runs,
    rpcError,
    balanceWarning,
    priceWarning,
    rpcWarning,
  } = snapshot;
  const [loading, setLoading] = useState(false);
  const [unresolvedTxs, setUnresolvedTxs] = useState<PendingTxRecord[]>([]);
  const unresolvedRef = useRef<PendingTxRecord[]>([]);
  const [rechecking, setRechecking] = useState(false);
  const [lastVerdict, setLastVerdict] = useState<{
    signature: string;
    verdict: PendingVerdict;
  } | null>(null);
  const [sessionCheckMsg, setSessionCheckMsg] = useState<string | null>(null);
  const [sessionChecking, setSessionChecking] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollStartedRef = useRef<Map<string, number>>(new Map());
  const restoreRef = useRef<
    (ownerAtStart: string, isCancelled: () => boolean) => Promise<void>
  >(async () => {});
  const [txPending, setTxPending] = useState(false);
  /** Closes the gap before withTx sets txPending. A second simulateBuy returns immediately. */
  const buyLockRef = useRef(false);
  /** Run indices this card created. A collision on one of these is not retried. */
  const createdRunIndicesRef = useRef(new Set<number>());
  /** Signature broadcast, not yet confirmed or rejected. Keeps Deposit/Kup disabled. */
  const pendingSigRef = useRef<string | null>(null);
  const [pendingSignature, setPendingSignatureState] = useState<string | null>(null);
  const [pendingMsg, setPendingMsg] = useState<string | null>(null);
  const watchingSigRef = useRef<string | null>(null);
  const ownerRef = useRef<PublicKey | null>(null);
  /** Previous wallet. Undefined until the first effect, so mount does not clear. */
  const seenOwnerKey = useRef<string | null | undefined>(undefined);
  function setPending(signature: string | null) {
    pendingSigRef.current = signature;
    setPendingSignatureState(signature);
    setPendingMsg(
      signature ? pendingTxMessage(signature, explorerTxUrl(signature)) : null,
    );
  }
  const [error, setError] = useState<string | null>(null);
  /** Sync last tx error (React state lags one render after await). */
  const lastErrorRef = useRef<string | null>(null);
  /** Bumps on wallet change so an in-flight refresh cannot write the previous owner. */
  const dataEpoch = useRef(0);
  /** Bumps when a new tx starts, and again on wallet change, so a late vault follow cannot toast. */
  const vaultFollowEpoch = useRef(0);
  function reportError(msg: string | null) {
    lastErrorRef.current = msg;
    setError(msg);
  }
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [jupPrices, setJupPrices] = useState<JupPrices>(() => emptyJupPrices(0));
  const [pricesLoading, setPricesLoading] = useState(false);
  const [runPriceByIndex, setRunPriceByIndex] = useState<
    Map<number, DecodedRunPrice | null>
  >(() => new Map());
  const snapshotRef = useRef(snapshot);
  const runPriceRef = useRef(runPriceByIndex);
  snapshotRef.current = snapshot;
  runPriceRef.current = runPriceByIndex;
  const refreshInFlightRef = useRef(false);
  const flightGen = useRef(0);
  const txPendingRef = useRef(false);
  const loadingRef = useRef(false);
  const buyExpectRef = useRef<{ prevRunCount: number; runIndex: number } | null>(null);
  const txVaultRef = useRef<{
    epoch: number;
    before: number | null;
    direction: "up" | "down";
  } | null>(null);
  const publishRef = useRef<(commit: RefreshCommit) => void>(() => {});
  publishRef.current = (commit) => {
    snapshotRef.current = commit.snapshot;
    runPriceRef.current = commit.prices;
    setSnapshot(commit.snapshot);
    setRunPriceByIndex(commit.prices);
  };

  const provider = useMemo(() => {
    if (!wallet) return null;
    return new AnchorProvider(connection, wallet, {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    });
  }, [connection, wallet]);

  const program = useMemo(
    () => (provider ? getProgram(provider) : null),
    [provider],
  );

  const owner = wallet?.publicKey ?? null;
  ownerRef.current = owner;
  const ownerKey = owner?.toBase58() ?? null;

  useEffect(() => {
    const prev = seenOwnerKey.current;
    seenOwnerKey.current = ownerKey;
    // First mount must not drop the initial refresh. A later pubkey change does.
    if (prev === undefined || prev === ownerKey) return;
    dataEpoch.current += 1;
    vaultFollowEpoch.current += 1;
    setPending(null);
    setOkMsg(null);
    reportError(null);
    setSnapshot(EMPTY_SNAPSHOT);
    setRunPriceByIndex(new Map());
    unresolvedRef.current = [];
    setUnresolvedTxs([]);
    setSessionChecking(new Set());
    setLastVerdict(null);
    setSessionCheckMsg(null);
    pollStartedRef.current.clear();
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, [ownerKey]);

  const refresh = useCallback(async (opts?: {
    publish?: boolean;
    nested?: boolean;
    quiet?: boolean;
    source?: "poll" | "critical";
  }): Promise<RefreshCommit | null> => {
    const nested = opts?.nested === true;
    const publish = opts?.publish !== false;
    const quiet = opts?.quiet === true;
    const source = opts?.source ?? "critical";
    const epochAtStart = dataEpoch.current;
    const ownerAtStart = owner?.toBase58() ?? null;
    const still = () =>
      refreshWriteStillCurrent(
        epochAtStart,
        ownerAtStart,
        dataEpoch.current,
        ownerRef.current?.toBase58() ?? null,
      );
    if (
      refreshCallDecision({
        source,
        inFlight: refreshInFlightRef.current,
        nested,
      }) === "skip"
    ) {
      return null;
    }
    if (!still()) return null;
    let myGen = 0;
    let readGen = 0;
    const mayPublish = () => publish && still() && flightGen.current === readGen;
    const finish = (
      partial: {
        config: PredcaSnapshot["config"];
        vaultUsdc: number | null;
        ownerUsdc: number | null;
        solBalance: number | null;
        runs: RunRecordData[];
        tokenRead: TokenBalanceRead;
      },
      priceRead: { map: Map<number, DecodedRunPrice | null>; ok: boolean },
    ): RefreshCommit => {
      if (partial.tokenRead.status === "error") {
        throw new Error(partial.tokenRead.detail ?? "token balance read failed");
      }
      const commit = commitRefreshRead({
        prevSnapshot: snapshotRef.current,
        prevPrices: runPriceRef.current,
        outcome: {
          ok: true,
          config: partial.config,
          vaultUsdc: partial.vaultUsdc,
          ownerUsdc: partial.ownerUsdc,
          solBalance: partial.solBalance,
          tokenBalances: partial.tokenRead.balances,
          tokenBalancesStale: partial.tokenRead.status === "unknown",
          runs: partial.runs,
        },
        prices: priceRead,
        runMeta: partial.runs.map((run) => ({
          runIndex: bnNum(run.runIndex),
          ts: bnNum(run.ts),
        })),
        nowMs: Date.now(),
      });
      if (mayPublish()) publishRef.current(commit);
      return commit;
    };
    try {
      if (!nested) {
        // Take the flight so an older read cannot publish over this one.
        myGen = ++flightGen.current;
        refreshInFlightRef.current = true;
        loadingRef.current = true;
        setLoading(true);
      }
      readGen = nested ? flightGen.current : myGen;
      const pricesPromise = loadJupPricesInBackground(
        fetchJupPrices,
        still,
        setJupPrices,
        setPricesLoading,
      );
      markHandled(pricesPromise);
      if (!quiet) reportError(null);
      if (!owner) {
        if (!still()) {
          return null;
        }
        const empty: RefreshCommit = { snapshot: EMPTY_SNAPSHOT, prices: new Map() };
        if (mayPublish()) publishRef.current(empty);
        return empty;
      }
      if (!still()) {
        return null;
      }
      const deadline = refreshDeadline(Date.now());
      const solPromise = withTimeout(
        fetchSolBalance(connection, owner),
        readTimeoutMs(deadline),
        "sol",
      );
      markHandled(solPromise);
      const ownerBalPromise = withTimeout(
        mint
          ? fetchOwnerUsdcBalance(connection, owner, mint)
          : Promise.resolve(null),
        readTimeoutMs(deadline),
        "ownerUsdc",
      );
      markHandled(ownerBalPromise);
      const tokenMs = readTimeoutMs(deadline);
      const tokensPromise = withTimeout(
        fetchMockTokenBalances(connection, owner, allMockMints(), {
          timeoutMs: tokenMs,
        }),
        tokenMs,
        "tokenBalances",
      ).then(
        (read) => read,
        (err: unknown) => {
          if (!isRpcTimeout(err)) throw err;
          const unknown: TokenBalanceRead = {
            balances: [],
            status: "unknown",
            detail: "balances.warning",
          };
          return unknown;
        },
      );
      markHandled(tokensPromise);

      if (!program) {
        const [sol, ownerBal, tokenRead] = await Promise.all([
          solPromise,
          ownerBalPromise,
          tokensPromise,
        ]);
        if (!still()) return null;
        return finish(
          {
            config: null,
            vaultUsdc: null,
            ownerUsdc: ownerBal,
            solBalance: sol,
            runs: [],
            tokenRead,
          },
          { map: new Map(), ok: true },
        );
      }

      const cfg = await fetchUserConfig(
        program,
        owner,
        readTimeoutMs(deadline),
      );
      if (!still()) return null;

      if (cfg) {
        const vaultPromise = withTimeout(
          fetchVaultBalance(connection, owner),
          readTimeoutMs(deadline),
          "vault",
        );
        markHandled(vaultPromise);
        const runsPromise = withTimeout(
          fetchRunRecords(program, owner),
          readTimeoutMs(deadline),
          "runs",
        );
        markHandled(runsPromise);
        const [bal, records, ownerBal, sol, tokenRead] = await Promise.all([
          vaultPromise,
          runsPromise,
          ownerBalPromise,
          solPromise,
          tokensPromise,
        ]);
        if (!still()) return null;
        let priceRead: { map: Map<number, DecodedRunPrice | null>; ok: boolean };
        try {
          priceRead = await fetchRunPrices(
            connection,
            owner,
            records.map((r) => bnNum(r.runIndex)),
            readTimeoutMs(deadline),
          );
        } catch {
          priceRead = { map: new Map(), ok: false };
        }
        if (!still()) return null;
        return finish(
          {
            config: cfg,
            vaultUsdc: bal,
            ownerUsdc: ownerBal,
            solBalance: sol,
            runs: records,
            tokenRead,
          },
          priceRead,
        );
      }

      const [ownerBal, sol, tokenRead] = await Promise.all([
        ownerBalPromise,
        solPromise,
        tokensPromise,
      ]);
      if (!still()) return null;
      return finish(
        {
          config: null,
          vaultUsdc: null,
          ownerUsdc: ownerBal,
          solBalance: sol,
          runs: [],
          tokenRead,
        },
        { map: new Map(), ok: true },
      );
    } catch (e) {
      if (!still()) return null;
      // A hung read is a soft miss: keep the previous snapshot, no rpcError,
      // so manual buy stays available. Any other throw is still a hard miss.
      const softTimeout = isRpcTimeout(e);
      const commit = commitRefreshRead({
        prevSnapshot: snapshotRef.current,
        prevPrices: runPriceRef.current,
        outcome: softTimeout
          ? { ok: false, soft: true }
          : { ok: false, error: rpcReadFailure(e) },
        prices: { map: new Map(), ok: false },
        runMeta: [],
        nowMs: Date.now(),
      });
      if (mayPublish()) publishRef.current(commit);
      return softTimeout ? { ...commit, softTimeout: true } : commit;
    } finally {
      if (!nested && flightGen.current === myGen) {
        refreshInFlightRef.current = false;
        loadingRef.current = false;
        (() => {
          if (!still()) return;
          setLoading(false);
        })();
      }
    }
  }, [program, owner, connection, mint]);

  useEffect(() => {
    // refresh() sets loading synchronously. A microtask keeps that off the
    // effect body so the first read is still the next turn, not a later tick.
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      void refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const tick = () => {
      if (
        chainPollDecision({
          visibilityState: document.visibilityState,
          txPending: txPendingRef.current,
          loading: loadingRef.current,
          refreshInFlight: refreshInFlightRef.current,
        }) !== "poll"
      ) {
        return;
      }
      void refresh({ quiet: true, source: "poll" });
    };
    const arm = () => {
      stop();
      if (document.visibilityState !== "visible") return;
      timer = setInterval(tick, CHAIN_POLL_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        tick();
        arm();
      } else {
        stop();
      }
    };
    if (document.visibilityState === "visible") arm();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, [refresh]);

  const refreshPrices = useCallback(async () => {
    const epochAtStart = dataEpoch.current;
    const ownerAtStart = owner?.toBase58() ?? null;
    const still = () =>
      refreshWriteStillCurrent(
        epochAtStart,
        ownerAtStart,
        dataEpoch.current,
        ownerRef.current?.toBase58() ?? null,
      );
    setPricesLoading(true);
    try {
      await refreshPricesOnly(fetchJupPrices, still, (value) => {
        if (still()) setJupPrices(value);
      });
    } finally {
      if (still()) setPricesLoading(false);
    }
  }, [owner]);

  useEffect(() => {
    if (!ownerKey) return;
    const ownerAtStart = ownerKey;
    let cancelled = false;
    void restoreRef.current(ownerAtStart, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [ownerKey]);

  const status: PredcaStatus = derivePredcaStatus({
    hasOwner: Boolean(owner),
    hasMint: Boolean(mint),
    loading,
    configState,
    rpcError,
  });

  const weeklyBudgetUsd = config
    ? rawToDollars(config.weeklyBudgetUsdc)
    : null;

  const lastRun = runs.length > 0 ? runs[runs.length - 1] : null;

  const lots = useMemo(
    () => runLots(runSources(runs), runPriceByIndex),
    [runs, runPriceByIndex],
  );

  const positions = useMemo(
    () => buildPositions(lots, tokenBalances, jupPrices),
    [lots, tokenBalances, jupPrices],
  );

  const runFills = useMemo(
    () =>
      fillsFor(
        runs.map((run) => ({
          runIndex: bnNum(run.runIndex),
          mints: run.mints.map((m) => (typeof m === "string" ? m : m.toBase58())),
          tokenAmounts: run.amounts.map((a) => rawToDollars(a)),
        })),
        runPriceByIndex,
      ),
    [runs, runPriceByIndex],
  );

  /** Pie weights follow USD value. Legacy 1:1 lots match the old unit weights. */
  const holdingsOnChain = useMemo((): Holding[] => {
    return valueWeights(positions).map((h, i) => ({
      name: h.name,
      value: h.value,
      color: holdingColor(h.name, i),
    }));
  }, [positions]);

  /**
   * Vault USDC + marked positions. Legacy tokens stay at cost ($1 per unit),
   * so with no RunPrice accounts this matches vault + Σ token units.
   * Wallet USDC is cash outside the DCA and is not included.
   */
  const portfolioUsd = useMemo(
    () =>
      portfolioUsdForWallet({
        hasOwner: Boolean(owner),
        priceWarning,
        balanceWarning,
        vaultUsdc,
        positions,
      }),
    [owner, priceWarning, balanceWarning, vaultUsdc, positions],
  );

  const lastPurchaseOnChain = useMemo(() => {
    if (!lastRun) return null;
    const idx = bnNum(lastRun.runIndex);
    const ts = bnNum(lastRun.ts);
    const presence = effectiveRunPricePresence(runPriceByIndex, idx, ts, Date.now());
    const dec = presence === "decoded" ? (runPriceByIndex.get(idx) ?? null) : null;
    return runToLastPurchase(lastRun, presence, dec);
  }, [lastRun, runPriceByIndex]);

  async function confirmLanded(signature: string): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < 45_000) {
      const { value } = await connection.getSignatureStatuses([signature]);
      const row = value[0];
      if (row?.err) {
        throw new Error(rejectedTxMessage(signature, explorerTxUrl(signature)));
      }
      if (
        row?.confirmationStatus === "confirmed" ||
        row?.confirmationStatus === "finalized"
      ) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    throw new Error(shown("tx.confirmStillPending"));
  }

  async function pollVaultAbove(before: number, budgetMs: number): Promise<boolean> {
    if (!owner) return false;
    const started = Date.now();
    while (Date.now() - started < budgetMs) {
      let vaultAfter = 0;
      try {
        vaultAfter = (await fetchVaultBalance(connection, owner)) ?? 0;
      } catch {
        vaultAfter = 0;
      }
      if (vaultAfter > before + 1e-6) return true;
      const left = budgetMs - (Date.now() - started);
      if (left <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(800, left)));
    }
    return false;
  }

  async function watchVaultCatchUp(
    epoch: number,
    before: number,
    success: string,
  ): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < CONFIRMED_VAULT_BACKGROUND_POLL_MS) {
      if (vaultFollowEpoch.current !== epoch || !owner) return;
      await new Promise((resolve) => setTimeout(resolve, 3000));
      if (vaultFollowEpoch.current !== epoch || !owner) return;
      try {
        const vaultAfter = (await fetchVaultBalance(connection, owner)) ?? 0;
        if (!(vaultAfter > before + 1e-6)) continue;
        if (vaultFollowEpoch.current !== epoch) return;
        await refresh();
        if (vaultFollowEpoch.current === epoch) {
          reportError(null);
          setOkMsg(success);
        }
        return;
      } catch {
        /* Public RPC can still be behind the confirmed signature. */
      }
    }
  }

  /** Same vault read as a confirmed deposit (fix B). Empty signature keeps the short poll. */
  async function applyConfirmedVault(
    epoch: number,
    signature: string,
    before: number,
    success: string,
  ): Promise<"error" | "ok"> {
    const increased = await pollVaultAbove(
      before,
      signature ? POST_CONFIRM_VAULT_POLL_MS : 12_000,
    );
    const outcome = outcomeAfterVaultCheck({
      confirmed: signature.length > 0,
      increased,
      success,
    });
    if (outcome.error) {
      await refresh();
      if (vaultFollowEpoch.current === epoch) reportError(outcome.error);
      return "error";
    }
    const note =
      !increased && signature
        ? `${shown("tx.vaultLag")} ${explorerTxUrl(signature)}`
        : outcome.ok;
    await refresh();
    if (vaultFollowEpoch.current !== epoch) return "ok";
    reportError(null);
    setOkMsg(note);
    if (!increased && signature) {
      void watchVaultCatchUp(epoch, before, success);
    }
    return "ok";
  }

  type SettleOpts = {
    epoch: number;
    success: string;
    requireVaultIncrease: boolean;
    vaultBefore: number | null;
    fromSession?: boolean;
    fromPoll?: boolean;
  };

  function persistRecord(rec: PendingTxRecord) {
    const storage = browserStorage();
    if (!storage) return;
    try {
      writePendingRecord(storage, rec);
    } catch {
      /* localStorage can throw in private mode. */
    }
  }

  function forgetRecord(rec: PendingTxRecord) {
    const storage = browserStorage();
    if (!storage) return;
    try {
      removePendingRecord(storage, rec.owner, rec.signature);
    } catch {
      /* ignore */
    }
  }

  function syncUnresolved(next: PendingTxRecord[]) {
    unresolvedRef.current = next;
    setUnresolvedTxs(next);
  }

  function dropUnresolved(signature: string) {
    pollStartedRef.current.delete(signature);
    syncUnresolved(
      unresolvedRef.current.filter((row) => row.signature !== signature),
    );
  }

  function schedulePoll() {
    if (pollTimerRef.current) return;
    const due = unresolvedRef.current.some((row) => {
      const started = pollStartedRef.current.get(row.signature);
      return started != null && Date.now() - started < UNRESOLVED_POLL_MAX_MS;
    });
    if (!due) return;
    pollTimerRef.current = setTimeout(() => {
      pollTimerRef.current = null;
      void runPoll();
    }, UNRESOLVED_POLL_MS);
  }

  function rememberUnresolved(rec: PendingTxRecord) {
    if (!pollStartedRef.current.has(rec.signature)) {
      pollStartedRef.current.set(rec.signature, Date.now());
    }
    const rest = unresolvedRef.current.filter((row) => row.signature !== rec.signature);
    syncUnresolved([rec, ...rest].sort((a, b) => b.createdAtMs - a.createdAtMs));
    schedulePoll();
  }

  function releasePending(signature: string, verdict: PendingVerdict) {
    setLastVerdict({ signature, verdict });
    if (pendingSigRef.current === signature && !pendingLockHeld(verdict)) {
      setPending(null);
    }
  }

  async function applyKnownVerdict(
    rec: PendingTxRecord,
    verdict: PendingVerdict,
    opts: SettleOpts,
  ): Promise<void> {
    const ownerNow = ownerRef.current?.toBase58() ?? null;
    if (ownerNow !== rec.owner) return;
    if (pendingSigRef.current != null && pendingSigRef.current !== rec.signature) return;

    releasePending(rec.signature, verdict);

    if (verdict === "confirmed") {
      forgetRecord(rec);
      dropUnresolved(rec.signature);
      if (opts.fromSession) {
        reportError(null);
        setOkMsg(priorSessionOk(rec));
        await refreshAfterTx(rec.kind, opts.epoch);
        return;
      }
      if (opts.requireVaultIncrease && ownerRef.current) {
        await applyConfirmedVault(
          opts.epoch,
          rec.signature,
          opts.vaultBefore ?? 0,
          opts.success,
        );
        return;
      }
      await refreshAfterTx(rec.kind, opts.epoch);
      if (!opts.fromPoll && !opts.fromSession && vaultFollowEpoch.current !== opts.epoch) {
        return;
      }
      reportError(null);
      setOkMsg(opts.success);
      return;
    }

    if (verdict === "rejected") {
      forgetRecord(rec);
      dropUnresolved(rec.signature);
      setOkMsg(null);
      reportError(rejectedTxMessage(rec.signature, explorerTxUrl(rec.signature)));
      return;
    }

    if (verdict === "failed_expired") {
      forgetRecord(rec);
      dropUnresolved(rec.signature);
      setOkMsg(null);
      reportError(
        `${FAILED_EXPIRED_MSG} ${rec.signature} ${explorerTxUrl(rec.signature)}`,
      );
      return;
    }

    rememberUnresolved(rec);
  }

  async function settleRecord(
    rec: PendingTxRecord,
    opts: SettleOpts,
  ): Promise<PendingVerdict> {
    const verdict = await checkPendingOnce(rec, signatureStatusDeps(connection));
    await applyKnownVerdict(rec, verdict, opts);
    return verdict;
  }

  async function runPoll() {
    const now = Date.now();
    const batch = unresolvedRef.current.slice();
    for (const rec of batch) {
      const started = pollStartedRef.current.get(rec.signature);
      if (started == null || now - started >= UNRESOLVED_POLL_MAX_MS) continue;
      if (!unresolvedRef.current.some((row) => row.signature === rec.signature)) continue;
      await settleRecord(rec, {
        epoch: vaultFollowEpoch.current,
        success: successForRecord(rec),
        requireVaultIncrease: false,
        vaultBefore: null,
        fromPoll: true,
      });
    }
    schedulePoll();
  }

  async function buildPendingRecord(
    signature: string,
    err: unknown,
    kind: PendingTxKind,
    amountUsd: number | null,
  ): Promise<PendingTxRecord> {
    let height: number | null = null;
    try {
      height = await connection.getBlockHeight("confirmed");
    } catch {
      height = null;
    }
    const rec: PendingTxRecord = {
      signature,
      owner: ownerRef.current?.toBase58() ?? "",
      kind,
      amountUsd,
      createdAtMs: Date.now(),
      expiryBlockHeight: height != null ? expiryFromHeight(height) : null,
      expiredAtError: isBlockheightExpiredError(err),
    };
    persistRecord(rec);
    return rec;
  }

  /**
   * Poll a still-unknown signature for about 60s. On confirm or on-chain
   * reject, clear the amber note. When the budget ends, take a verdict and
   * release the global lock.
   */
  function watchUnresolved(follow: {
    epoch: number;
    signature: string;
    success: string;
    requireVaultIncrease: boolean;
    vaultBefore: number | null;
    record: PendingTxRecord;
  }) {
    if (watchingSigRef.current === follow.signature) return;
    watchingSigRef.current = follow.signature;
    void (async () => {
      const started = Date.now();
      const finishWindow = async () => {
        if (pendingSigRef.current !== follow.signature) return;
        await settleRecord(follow.record, {
          epoch: follow.epoch,
          success: follow.success,
          requireVaultIncrease: follow.requireVaultIncrease,
          vaultBefore: follow.vaultBefore,
        });
      };
      try {
        while (pendingSigRef.current === follow.signature) {
          const elapsed = Date.now() - started;
          if (elapsed >= UNRESOLVED_WATCH_MS) {
            await finishWindow();
            return;
          }
          const wait = Math.min(
            UNRESOLVED_WATCH_POLL_MS,
            UNRESOLVED_WATCH_MS - elapsed,
          );
          await new Promise((resolve) => setTimeout(resolve, wait));
          if (pendingSigRef.current !== follow.signature) return;
          if (Date.now() - started >= UNRESOLVED_WATCH_MS) {
            await finishWindow();
            return;
          }
          if (!ownerRef.current) {
            setPending(null);
            return;
          }
          let row: Awaited<
            ReturnType<typeof connection.getSignatureStatuses>
          >["value"][number] = null;
          try {
            const { value } = await connection.getSignatureStatuses(
              [follow.signature],
              { searchTransactionHistory: true },
            );
            row = value[0];
          } catch {
            continue;
          }
          if (row?.err) {
            if (pendingSigRef.current !== follow.signature) return;
            if (vaultFollowEpoch.current !== follow.epoch) {
              setPending(null);
              return;
            }
            forgetRecord(follow.record);
            dropUnresolved(follow.signature);
            releasePending(follow.signature, "rejected");
            setOkMsg(null);
            reportError(
              rejectedTxMessage(follow.signature, explorerTxUrl(follow.signature)),
            );
            return;
          }
          if (
            row?.confirmationStatus === "confirmed" ||
            row?.confirmationStatus === "finalized"
          ) {
            if (pendingSigRef.current !== follow.signature) return;
            if (vaultFollowEpoch.current !== follow.epoch) {
              setPending(null);
              return;
            }
            forgetRecord(follow.record);
            dropUnresolved(follow.signature);
            releasePending(follow.signature, "confirmed");
            if (follow.requireVaultIncrease && ownerRef.current) {
              await applyConfirmedVault(
                follow.epoch,
                follow.signature,
                follow.vaultBefore ?? 0,
                follow.success,
              );
              return;
            }
            await refreshAfterTx(follow.record.kind, follow.epoch);
            if (vaultFollowEpoch.current !== follow.epoch) return;
            reportError(null);
            setOkMsg(follow.success);
            return;
          }
        }
      } finally {
        if (watchingSigRef.current === follow.signature) {
          watchingSigRef.current = null;
        }
      }
    })();
  }

  async function refreshAfterTx(kind: PendingTxKind, epoch: number): Promise<void> {
    const followStill = () => vaultFollowEpoch.current === epoch;
    const myGen = ++flightGen.current;
    refreshInFlightRef.current = true;
    let failed: RefreshCommit | null = null;
    try {
      if (!followStill()) return;
      if (kind === "budget") {
        await refresh({ publish: true, nested: true, quiet: true });
        return;
      }
      const expect = kind === "buy" ? buyExpectRef.current : null;
      const vaultRetry = txVaultRef.current;
      const useVault =
        (kind === "deposit" || kind === "init_deposit" || kind === "withdraw") &&
        vaultRetry != null &&
        vaultRetry.epoch === epoch;
      const result = await retryRefresh({
        still: followStill,
        refresh: async () => {
          const commit = await refresh({ publish: false, nested: true, quiet: true });
          const readable = postTxReadAttempt(commit);
          if (commit != null && readable == null) {
            failed = commit;
            return null;
          }
          return readable;
        },
        settled: (commit) => {
          if (kind === "buy") {
            if (expect == null) return false;
            return buyRefreshSettled({
              prevRunCount: expect.prevRunCount,
              expectedRunIndex: expect.runIndex,
              runs: runSources(commit.snapshot.runs),
              prices: commit.prices,
              balances: commit.snapshot.tokenBalances,
              nowMs: Date.now(),
            });
          }
          if (useVault && vaultRetry) {
            return vaultMoved(
              vaultRetry.before,
              commit.snapshot.vaultUsdc,
              vaultRetry.direction,
            );
          }
          return false;
        },
      });
      if (!followStill() || flightGen.current !== myGen) return;
      const chosen = result.last ?? failed;
      if (chosen) publishRef.current(chosen);
    } finally {
      if (flightGen.current === myGen) {
        refreshInFlightRef.current = false;
        loadingRef.current = false;
        if (followStill()) setLoading(false);
      }
    }
  }

  async function withTx<T>(
    fn: () => Promise<T>,
    success: string,
    opts: {
      requireVaultIncrease?: boolean;
      kind: PendingTxKind;
      amountUsd?: number | null;
    },
  ): Promise<T | null> {
    // A second entry would drop the watcher and send another fee-payer tx.
    if (unresolvedSignatureBlocksTx(pendingSigRef.current)) return null;
    const epoch = ++vaultFollowEpoch.current;
    reportError(null);
    setOkMsg(null);
    setPending(null);
    txPendingRef.current = true;
    setTxPending(true);
    const trackVault =
      opts.kind === "deposit" ||
      opts.kind === "init_deposit" ||
      opts.kind === "withdraw";
    const vaultBefore =
      owner && (Boolean(opts.requireVaultIncrease) || trackVault)
        ? await readVaultOrNull(connection, owner)
        : null;
    txVaultRef.current = trackVault
      ? {
          epoch,
          before: vaultBefore,
          direction: opts.kind === "withdraw" ? "down" : "up",
        }
      : null;
    const followBase = {
      epoch,
      success,
      requireVaultIncrease: Boolean(opts.requireVaultIncrease && owner),
      vaultBefore,
    };
    try {
      const result = await fn();
      if (opts.requireVaultIncrease && owner) {
        const signature =
          typeof result === "string" && result.length > 0 ? result : "";
        if (signature) await confirmLanded(signature);
        // A confirmed tx can still read the old vault from another replica.
        const settled = await applyConfirmedVault(
          epoch,
          signature,
          vaultBefore ?? 0,
          success,
        );
        return settled === "error" ? null : result;
      }
      setOkMsg(success);
      await refreshAfterTx(opts.kind, epoch);
      return result;
    } catch (e) {
      if (isOnChainSignatureReject(e)) {
        setPending(null);
        if (vaultFollowEpoch.current === epoch) {
          setOkMsg(null);
          reportError(
            e instanceof Error
              ? e.message
              : translate(getLocaleSnapshot(), "tx.err.rejectedShort"),
          );
        }
        return null;
      }
      const pending = isUnconfirmedTimeout(e);
      if (!pending) {
        reportError(
          privySendFailureMessage(e, getLocaleSnapshot(), isPrivy) ??
            parseAnchorError(e),
        );
        return null;
      }
      const signature = pending.signature;
      setPending(signature);
      if (vaultFollowEpoch.current === epoch) {
        reportError(null);
        setOkMsg(null);
      }
      const rec = await buildPendingRecord(
        signature,
        e,
        opts.kind,
        opts.amountUsd ?? null,
      );
      if (pendingSigRef.current !== signature) return null;
      if (rec.expiredAtError) {
        const started = Date.now();
        for (const at of [2_000, 6_000]) {
          const wait = at - (Date.now() - started);
          if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
          if (pendingSigRef.current !== signature) return null;
          if (vaultFollowEpoch.current !== epoch) return null;
          const early = await checkPendingOnce(rec, signatureStatusDeps(connection));
          if (early !== "unresolved") {
            await applyKnownVerdict(rec, early, followBase);
            return null;
          }
        }
        if (pendingSigRef.current !== signature) return null;
        await settleRecord(rec, followBase);
        return null;
      }
      try {
        await confirmLanded(signature);
      } catch (confirmErr) {
        if (isOnChainSignatureReject(confirmErr)) {
          forgetRecord(rec);
          dropUnresolved(signature);
          releasePending(signature, "rejected");
          if (vaultFollowEpoch.current === epoch) {
            setOkMsg(null);
            reportError(
              confirmErr instanceof Error
                ? confirmErr.message
                : rejectedTxMessage(signature, explorerTxUrl(signature)),
            );
          }
          return null;
        }
        watchUnresolved({
          ...followBase,
          signature,
          record: rec,
        });
        return null;
      }
      forgetRecord(rec);
      dropUnresolved(signature);
      releasePending(signature, "confirmed");
      if (opts.requireVaultIncrease && owner) {
        const settled = await applyConfirmedVault(
          epoch,
          signature,
          vaultBefore ?? 0,
          success,
        );
        return settled === "error" ? null : (signature as T);
      }
      await refreshAfterTx(opts.kind, epoch);
      if (vaultFollowEpoch.current !== epoch) return signature as T;
      reportError(null);
      setOkMsg(success);
      return signature as T;
    } finally {
      txPendingRef.current = false;
      setTxPending(false);
    }
  }

  restoreRef.current = async (ownerAtStart, isCancelled) => {
    await Promise.resolve();
    if (isCancelled()) return;
    const storage = browserStorage();
    if (!storage) return;
    let records: PendingTxRecord[] = [];
    try {
      records = readPendingRecords(storage, ownerAtStart, Date.now());
    } catch {
      return;
    }
    if (isCancelled() || (ownerRef.current?.toBase58() ?? null) !== ownerAtStart) return;
    if (records.length === 0) return;
    setSessionCheckMsg(shown("tx.sessionCheck"));
    for (const rec of records) {
      if (!pollStartedRef.current.has(rec.signature)) {
        pollStartedRef.current.set(rec.signature, Date.now());
      }
    }
    setSessionChecking(new Set(records.map((r) => r.signature)));
    syncUnresolved(records);
    schedulePoll();
    for (const rec of records) {
      if (isCancelled() || (ownerRef.current?.toBase58() ?? null) !== ownerAtStart) return;
      try {
        await settleRecord(rec, {
          epoch: vaultFollowEpoch.current,
          success: successForRecord(rec),
          requireVaultIncrease: false,
          vaultBefore: null,
          fromSession: true,
        });
      } finally {
        setSessionChecking((prev) => {
          const next = new Set(prev);
          next.delete(rec.signature);
          return next;
        });
      }
    }
    if (!isCancelled() && (ownerRef.current?.toBase58() ?? null) === ownerAtStart) {
      setSessionCheckMsg(null);
    }
  };

  async function recheckUnresolved(signature?: string): Promise<PendingVerdict> {
    setRechecking(true);
    try {
      const targets = signature
        ? unresolvedRef.current.filter((row) => row.signature === signature)
        : unresolvedRef.current.slice();
      let last: PendingVerdict = "unresolved";
      for (const rec of targets) {
        last = await settleRecord(rec, {
          epoch: vaultFollowEpoch.current,
          success: successForRecord(rec),
          requireVaultIncrease: false,
          vaultBefore: null,
        });
      }
      return last;
    } finally {
      setRechecking(false);
    }
  }

  /**
   * Deposit USDC into vault.
   * If UserConfig is missing: initialize_user + deposit_usdc in one transaction
   * (weeklyBudgetUsdForInit required / used as on-chain weekly budget).
   */
  async function depositUsdc(
    amountUsd: number,
    weeklyBudgetUsdForInit?: number,
  ) {
    if (!program || !owner || !mint || !provider) {
      reportError(
        !mint
          ? shown("tx.err.noUsdcMint", { mint: MOCK_USDC_MINT })
          : shown("tx.err.connectWallet"),
      );
      return null;
    }
    const raw = dollarsToRaw(amountUsd);
    if (raw.lte(new BN(0))) {
      reportError(shown("tx.err.depositPositive"));
      return null;
    }
    const ownerUsdcAtaPk = ownerUsdcAta(owner, mint);
    const plan = depositPlan(configState, rpcError);
    if (plan === "blocked") {
      reportError(rpcReadErrorMessage());
      return null;
    }

    // First deposit: initialize_user + deposit_usdc in one tx.
    if (plan === "init_deposit") {
      const budgetUsd =
        weeklyBudgetUsdForInit != null &&
        Number.isFinite(weeklyBudgetUsdForInit) &&
        weeklyBudgetUsdForInit > 0
          ? weeklyBudgetUsdForInit
          : 0;
      const budgetRaw = dollarsToRaw(budgetUsd);
      if (budgetRaw.lte(new BN(0))) {
        reportError(shown("tx.err.firstDepositBudget"));
        return null;
      }
      const initLocale = getLocaleSnapshot();
      return withTx(
        () =>
          withOneStaleBlockhashRetry(isPrivy, async () => {
            const initIx = await program.methods
              .initializeUser(budgetRaw)
              .accounts({ usdcMint: mint })
              .instruction();
            const depositIx = await program.methods
              .depositUsdc(raw)
              .accounts({
                usdcMint: mint,
                ownerUsdc: ownerUsdcAtaPk,
              })
              .instruction();
            const tx = new Transaction().add(initIx, depositIx);
            return provider.sendAndConfirm(tx);
          }),
        translate(initLocale, "tx.ok.initDeposit", {
          amount: txAmount(initLocale, amountUsd),
        }),
        {
          requireVaultIncrease: isPrivy,
          kind: "init_deposit",
          amountUsd,
        },
      );
    }

    const depositLocale = getLocaleSnapshot();
    return withTx(
      () =>
        withOneStaleBlockhashRetry(isPrivy, () =>
          program.methods
            .depositUsdc(raw)
            .accounts({
              usdcMint: mint,
              ownerUsdc: ownerUsdcAtaPk,
            })
            .rpc(),
        ),
      translate(depositLocale, "tx.ok.deposit", {
        amount: txAmount(depositLocale, amountUsd),
      }),
      { requireVaultIncrease: isPrivy, kind: "deposit", amountUsd },
    );
  }

  async function withdrawUsdc(amountUsd: number) {
    if (!program || !owner || !mint) {
      reportError(
        !mint
          ? shown("tx.err.noUsdcMint", { mint: MOCK_USDC_MINT })
          : shown("tx.err.connectWallet"),
      );
      return null;
    }
    if (rpcError) {
      reportError(rpcReadErrorMessage());
      return null;
    }
    if (!config) {
      reportError(shown("tx.err.predcaNotInit"));
      return null;
    }
    const raw = dollarsToRaw(amountUsd);
    if (raw.lte(new BN(0))) {
      reportError(shown("tx.err.withdrawPositive"));
      return null;
    }
    const ownerUsdcAtaPk = ownerUsdcAta(owner, mint);
    const withdrawLocale = getLocaleSnapshot();
    return withTx(
      () =>
        withOneStaleBlockhashRetry(isPrivy, () =>
          program.methods
            .withdrawUsdc(raw)
            .accounts({
              usdcMint: mint,
              ownerUsdc: ownerUsdcAtaPk,
            })
            .rpc(),
        ),
      translate(withdrawLocale, "tx.ok.withdraw", {
        amount: txAmount(withdrawLocale, amountUsd),
      }),
      { kind: "withdraw", amountUsd },
    );
  }

  async function setWeeklyBudget(weeklyBudgetUsd: number) {
    if (!program || !owner) {
      reportError(shown("tx.err.connectWallet"));
      return null;
    }
    if (rpcError) {
      reportError(rpcReadErrorMessage());
      return null;
    }
    // Lone initialize_user is not a Settings/auto-buy path. The account is
    // created only by the first deposit (initialize_user + deposit_usdc).
    if (!config) {
      reportError(shown("auto.status.notReady"));
      return null;
    }
    const raw = dollarsToRaw(weeklyBudgetUsd);
    if (raw.lte(new BN(0))) {
      reportError(shown("tx.err.budgetPositive"));
      return null;
    }
    return withTx(
      () =>
        withOneStaleBlockhashRetry(isPrivy, () =>
          program.methods.setWeeklyBudget(raw).rpc(),
        ),
      translate(getLocaleSnapshot(), "tx.ok.budget"),
      { kind: "budget", amountUsd: weeklyBudgetUsd },
    );
  }

  /**
   * Approx tokens at the cached PriceFeed. Empty when a feed is missing.
   * Display only — the chain still checks staleness on simulate_buy_v2.
   */
  const previewBuy = useCallback(async (tokenNames: string[]): Promise<BuyPreviewLeg[]> => {
    if (!owner || !mint) return [];
    const { mints, names, missing } = resolveTop3Mints(tokenNames);
    if (missing.length > 0 || mints.length !== 3) return [];
    const budget = config ? rawToDollars(config.weeklyBudgetUsdc) : null;
    if (budget == null || !(budget > 0)) return [];
    const usdcEach = BigInt(Math.floor((budget * 1e6) / 3));
    let feeds;
    try {
      feeds = await fetchPriceFeedsCached(connection, mints);
    } catch {
      return [];
    }
    const legs: BuyPreviewLeg[] = [];
    for (let i = 0; i < 3; i++) {
      const feed = feeds[i];
      if (!feed) continue;
      const priceUsd = usdPerToken(feed.price, feed.priceDecimals);
      const tokens = wholeTokensFromBase(
        mintedBaseUnits(usdcEach, feed.price, feed.priceDecimals),
      );
      if (priceUsd == null || !(tokens > 0)) continue;
      legs.push({ name: names[i] ?? "", tokens, priceUsd });
    }
    return legs;
  }, [owner, mint, config, connection]);

  /**
   * On-chain simulate_buy_v2 (priced buy). Debits vault USDC only and mints
   * floor(usdc/price) of each mock PreStock to the owner ATAs.
   */
  async function simulateBuy(tokenNames: string[]): Promise<string | null> {
    if (!program || !owner || !mint) {
      reportError(
        !mint
          ? shown("tx.err.noUsdcMint", { mint: MOCK_USDC_MINT })
          : shown("tx.err.connectWallet"),
      );
      return null;
    }
    if (rpcError) {
      reportError(rpcReadErrorMessage());
      return null;
    }
    if (!config) {
      reportError(shown("tx.err.predcaNotInit"));
      return null;
    }

    const { mints, names, missing } = resolveTop3Mints(tokenNames);
    if (missing.length > 0) {
      reportError(shown("tx.err.missingMints", { names: missing.join(", ") }));
      return null;
    }
    if (mints.length !== 3) {
      reportError(shown("tx.err.needThreeMints"));
      return null;
    }

    // Before the first await. withTx sets txPending only after config/vault/index.
    // Do not reportError here: a duplicate call must not clobber the buy in flight.
    if (!tryEnterManualBuy(buyLockRef, false)) return null;
    txPendingRef.current = true;
    setTxPending(true);
    try {
      // Re-fetch config so budget is fresh after setWeeklyBudget in the same turn
      // (hook closure would otherwise keep the pre-sync weeklyBudgetUsd).
      const freshConfig = await fetchUserConfig(program, owner);
      if (!freshConfig) {
        reportError(shown("tx.err.predcaNotInit"));
        return null;
      }
      const budget = rawToDollars(freshConfig.weeklyBudgetUsdc);
      const amountEach = Math.floor((budget * 1e6) / 3) / 1e6;
      const totalDebit = amountEach * 3;
      const usdcEachRaw = BigInt(Math.floor(budget * 1e6 / 3));
      // One fresh vault read. The number on screen is only a fallback.
      let freshVault: number | null = null;
      let vaultReadError: unknown = null;
      try {
        freshVault = await fetchVaultBalance(connection, owner);
      } catch (e) {
        vaultReadError = e;
      }
      const vaultNow = resolveVaultBalanceForBuy(freshVault, vaultUsdc, vaultReadError);
      if (vaultNow == null || vaultNow < totalDebit) {
        const locale = getLocaleSnapshot();
        reportError(
          translate(locale, "msg.vaultLowOnChain", {
            have: formatDollars(vaultNow ?? 0),
            need: formatDollars(totalDebit),
          }),
        );
        return null;
      }

      // Fresh on-chain index. `runs` is stale after a keeper buy until refresh.
      let scanned: number | null;
      try {
        scanned = await findNextRunIndex(program, owner);
      } catch (e) {
        reportError(parseAnchorError(e));
        return null;
      }
      if (scanned == null) {
        reportError(shown("tx.err.noFreeRunIndex"));
        return null;
      }
      const nextIndex = scanned;

      const submitAt = async (runIndex: number) => {
        // Anchor resolves PDAs that have seeds (vault, mint_auth, ATAs, run_record).
        // price_feed_* and run_price have no IDL seeds and must be passed.
        const buyMethod = (index: number) =>
          program.methods
            .simulateBuyV2(
              new BN(index),
              mints,
              Array.from({ length: 32 }, () => 0),
            )
            .accounts({
              usdcMint: mint,
              mintA: mints[0],
              mintB: mints[1],
              mintC: mints[2],
              priceFeedA: priceFeedPda(mints[0])[0],
              priceFeedB: priceFeedPda(mints[1])[0],
              priceFeedC: priceFeedPda(mints[2])[0],
              runPrice: runPricePda(owner, index)[0],
            });

        // The program requires the three owner token accounts. A separate
        // create used to wait on confirmTransaction, which needs a websocket.
        // Without one it threw after the blockhash expired, and that error
        // was reported as a finished purchase even though the buy never ran.
        const atas = mints.map((mintKey) => ownerAtaAddress(owner, mintKey));
        const infos = await withOneNetworkRetry(() =>
          connection.getMultipleAccountsInfo(atas),
        );
        const missing = missingAtaIndexes(infos.map((info) => info != null));
        const ataIxs = ataCreateInstructions(owner, mints, missing);
        const locale = getLocaleSnapshot();
        let plan: "buy-only" | "combined" | "two-step" = "buy-only";
        let blockhash = "";
        let buyIx: TransactionInstruction | null = null;
        if (missing.length > 0) {
          buyIx = await buyMethod(runIndex).instruction();
          blockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
          plan = chooseBuySubmit(
            missing.length,
            legacyPacketBytes(
              assembleBuyTransaction(ataIxs, buyIx, owner, blockhash),
            ),
          );
        }

        const sendAndConfirm = async (tx: Transaction): Promise<string> => {
          tx.feePayer = owner;
          tx.recentBlockhash = blockhash;
          const sig = await sendTransaction(tx, connection, {
            skipPreflight: false,
            preflightCommitment: "confirmed",
          });
          await confirmSignatureByPolling(
            async (signature) => {
              const { value } = await connection.getSignatureStatuses([signature]);
              const row = value[0];
              if (!row) return [null];
              return [
                {
                  err: row.err,
                  confirmationStatus: row.confirmationStatus ?? null,
                },
              ];
            },
            sig,
            {
              readLogs: async (signature) => {
                const landed = await connection.getTransaction(signature, {
                  maxSupportedTransactionVersion: 0,
                  commitment: "confirmed",
                });
                return landed?.meta?.logMessages ?? null;
              },
            },
          );
          return sig;
        };

        if (plan === "combined") {
          if (!buyIx) {
            throw new Error(translate(locale, "tx.err.noBuyIx"));
          }
          return sendAndConfirm(
            assembleBuyTransaction(ataIxs, buyIx, owner, blockhash),
          );
        }

        if (plan === "two-step") {
          setOkMsg(translate(locale, "buy.stepAta"));
          try {
            await sendAndConfirm(
              transactionFromInstructions(ataIxs, owner, blockhash),
            );
          } catch (e) {
            setOkMsg(null);
            if (isStaleBlockhashError(e)) throw e;
            if (isUnconfirmedTimeout(e)) {
              const sig = isUnconfirmedTimeout(e)?.signature ?? "";
              throw new Error(
                `${translate(locale, "buy.ataUnconfirmedNoBuy")}${sig ? ` ${sig}` : ""}`,
              );
            }
            throw e;
          }
          setOkMsg(translate(locale, "buy.stepBuy"));
        }

        try {
          return await buyMethod(runIndex).rpc();
        } catch (e) {
          if (plan !== "two-step") throw e;
          if (isUnconfirmedTimeout(e) || isStaleBlockhashError(e)) throw e;
          setOkMsg(null);
          const lead = translate(locale, "buy.ataCreatedNoVault");
          const detail = parseAnchorError(e);
          throw new Error(detail ? `${lead} ${detail}` : lead);
        }
      };

      const submitOnce = (runIndex: number) =>
        withOneStaleBlockhashRetry(isPrivy, () => submitAt(runIndex));

      const submitAndRemember = async (runIndex: number) => {
        if (buyExpectRef.current) {
          buyExpectRef.current = { ...buyExpectRef.current, runIndex };
        }
        try {
          const sig = await submitOnce(runIndex);
          createdRunIndicesRef.current.add(runIndex);
          return sig;
        } catch (e) {
          // Timeout may already have created this RunRecord. Do not buy the next index.
          noteUnconfirmedRunIndex(createdRunIndicesRef.current, runIndex, e);
          throw e;
        }
      };

      const buyLocale = getLocaleSnapshot();
      let preview = "";
      try {
        const feeds = await fetchPriceFeedsCached(connection, mints);
        const bits: string[] = [];
        for (let i = 0; i < names.length; i++) {
          const feed = feeds[i];
          if (!feed) continue;
          const priceUsd = usdPerToken(feed.price, feed.priceDecimals);
          const tokens = wholeTokensFromBase(
            mintedBaseUnits(usdcEachRaw, feed.price, feed.priceDecimals),
          );
          if (priceUsd == null || !(tokens > 0)) continue;
          bits.push(
            translate(buyLocale, "tx.buyPreviewLeg", {
              tokens: formatCount(buyLocale, tokens, { max: 6 }),
              name: names[i] ?? "",
              price: formatCount(buyLocale, priceUsd, { min: 2, max: 2 }),
            }),
          );
        }
        if (bits.length > 0) preview = ` ${bits.join(" · ")}`;
      } catch {
        preview = "";
      }

      buyExpectRef.current = { prevRunCount: nextIndex, runIndex: nextIndex };
      return await withTx(async () => {
        try {
          return await submitAndRemember(nextIndex);
        } catch (e) {
          if (!isRunAlreadyExists(e)) throw e;
          try {
            return await recoverRunCollision({
              failedIndex: nextIndex,
              createdRunIndices: createdRunIndicesRef.current,
              findNextIndex: () => findNextRunIndex(program, owner),
              submitOnce: submitAndRemember,
            });
          } catch (e2) {
            if (isRunAlreadyExists(e2)) throw new Error(shown("auto.error.predca.6004"));
            throw e2;
          }
        }
      }, translate(buyLocale, "tx.ok.simulateBuy", {
        amount: txAmount(buyLocale, totalDebit, 2),
        names: names.join(" · "),
        preview,
      }), {
        kind: "buy",
        amountUsd: totalDebit,
      });
    } catch (e) {
      reportError(parseAnchorError(e));
      return null;
    } finally {
      buyExpectRef.current = null;
      leaveManualBuy(buyLockRef);
      txPendingRef.current = false;
      setTxPending(false);
    }
  }

  /** Error and success toasts only. Never touches an unresolved signature. */
  function clearToasts() {
    clearMessages({ keepPending: true });
  }

  function clearMessages(opts?: { keepPending?: boolean }) {
    reportError(null);
    setOkMsg(null);
    if (clearDropsPending(opts)) setPending(null);
  }

  return {
    owner,
    mint,
    mintHint: mintHint(),
    status,
    loading,
    txPending,
    /** Set while a broadcast signature is neither confirmed nor rejected. */
    pendingSignature,
    /** Amber copy for pendingSignature. Not the teal success toast. */
    pendingMsg,
    pendingSignatureNow: () => pendingSigRef.current,
    configState,
    rpcError,
    balanceWarning: balanceWarning ?? null,
    priceWarning: priceWarning ?? null,
    rpcWarning: rpcWarning ?? null,
    unresolvedTxs,
    visibleUnresolvedTxs: visibleUnresolved(unresolvedTxs, sessionChecking),
    recheckUnresolved,
    rechecking,
    unresolvedFor: (kind: PendingTxKind) => {
      if (!DUPLICATE_GUARD_KINDS.has(kind)) return null;
      return unresolvedTxs.find((row) => sameActionFamily(row.kind, kind)) ?? null;
    },
    lastVerdict,
    sessionCheckMsg,
    error,
    /** Immediate last tx/validation error after await (ref). */
    lastTxError: () => lastErrorRef.current ?? error,
    okMsg,
    clearToasts,
    clearMessages,
    config,
    vaultUsdc,
    ownerUsdc,
    solBalance,
    tokenBalances,
    holdingsOnChain,
    portfolioUsd,
    positions,
    jupPrices,
    pricesLoading,
    refreshPrices,
    runFills,
    weeklyBudgetUsd,
    runs,
    lastRun,
    lastPurchaseOnChain,
    refresh,
    depositUsdc,
    withdrawUsdc,
    setWeeklyBudget,
    simulateBuy,
    previewBuy,
  };
}

type PredcaApi = ReturnType<typeof usePredcaImpl>;

const PredcaContext = createContext<PredcaApi | null>(null);

export function PredcaProvider({ children }: { children: ReactNode }) {
  const value = usePredcaImpl();
  return createElement(PredcaContext.Provider, { value }, children);
}

export function usePredca() {
  const ctx = useContext(PredcaContext);
  if (!ctx) {
    throw new Error("usePredca must be used within PredcaProvider");
  }
  return ctx;
}

