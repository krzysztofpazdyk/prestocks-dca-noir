"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { claimFaucetUsdc } from "@/lib/dca-api";
import { HoldingsPie } from "./HoldingsPie";
import { fmtPriceClock, fmtSignedPnl, fmtUsdAmount } from "@/lib/format-usd";
import { formatDollars, formatGrouped } from "@/lib/number-format";
import {
  purchaseMsgClass,
  purchaseMsgTone,
} from "@/lib/purchase-msg-tone";
import { renderPurchaseNotice, type PurchaseNotice } from "@/lib/purchase-notice";
import {
  canonicalName,
  isLowLiquidity,
  quoteByName,
  type JupPrices,
} from "@/lib/jup-prices";
import { priceRows, type PriceRowFlag } from "@/lib/price-rows";
import {
  pnlSummary,
  portfolioTileState,
  positionPnlKind,
  type PositionRow,
} from "@/lib/position-value";
import {
  DEFAULT_SETTINGS,
  type Holding,
  type Purchase,
} from "@/lib/mock-data";
import { purchaseDisabledReasonKey } from "@/lib/purchase-reason";
import { readWeeklyBudgetUsd } from "@/lib/auto-weekly-buy";
import {
  adoptWeeklyDraftForOwner,
  budgetsDiffer,
  needsBudgetConfirm,
  subscribeWeeklyBudget,
  WEEKLY_BUDGET_EPS,
  weeklyBudgetRevision,
  weeklyBudgetServerRevision,
} from "@/lib/weekly-budget";
import { usePredca } from "@/lib/hooks/usePredca";
import { leaveManualBuy, tryEnterManualBuy } from "@/lib/manual-buy-guard";
import { isOnChainSignatureReject } from "@/lib/vault-follow-up";
import { depositUi, withdrawUi } from "@/lib/predca-status";
import { dupOutcomeMessage } from "@/lib/dup-message";
import {
  FAILED_EXPIRED_MSG,
  UNRESOLVED_MSG,
  leaveDupCheck,
  nextDuplicateStep,
  tryEnterDupCheck,
} from "@/lib/pending-tx";
import { PrivySignWaitNotice } from "@/components/PrivyWalletBridge";
import { TxNotice, txMessageWithLink } from "@/components/TxNotice";
import {
  clusterShortPl,
  explorerTxUrl,
  formatUsd,
  rawToDollars,
  rpcHost,
} from "@/lib/predca";
import { mintLabel } from "@/lib/mint-label";
import {
  formatPremiumPct,
  livePremiumPct,
  PREMIUM_TONE_CLASS,
  premiumCopy,
  showsSpacexDiscount,
  type PremiumTone,
} from "@/lib/premium-view";
import {
  fetchPrestocksProducts,
  fillNoticeVars,
  PRESTOCKS_SNAPSHOT_DATE,
} from "@/lib/prestocks";
import {
  isFlatFallback,
  parseRankSession,
  rankPrefsKey,
  rankSessionClientSnapshot,
  rankSessionServerSnapshot,
  restoreRankSession,
  runRankingNow,
  subscribeRankSession,
} from "@/lib/ranking";
import { useI18n } from "@/lib/i18n";
import { APP_VERSION } from "@/lib/app-version";
import type { RankResult } from "@/lib/universe";

/** Page-load clock. Avoids Date.now() during render (react-hooks/purity). */
const UI_CLOCK_AT = Date.now();

/** Short Top-3 h2 from RankResult.mode — never claim live Jev for metrics. */
function top3TitleFromRank(result: RankResult, locale: string): string {
  const grok = (result.pipeline || []).includes("grok");
  if (result.mode === "metrics_fallback") {
    return locale === "en" ? "Top-3 · metrics" : "Top-3 · metryki";
  }
  if (result.mode === "byok_ai") {
    if (grok) return "Top-3 · Grok+Jev";
    return "Top-3 · AI (BYOK)";
  }
  // hosted_jev / cache / other
  return locale === "en" ? "Top-3 · ranking" : "Top-3 · ranking";
}

const BUDGET_EPS = WEEKLY_BUDGET_EPS;

/** Intended buy amount: Settings LS is SoT; on-chain is synced before Manual Buy. */
function resolvePurchaseAmount(
  onChainWeeklyUsd: number | null,
  owner?: string | null,
): number {
  const ls = readWeeklyBudgetUsd(DEFAULT_SETTINGS.weeklyAmountUsd, owner);
  if (ls > 0) return ls;
  if (onChainWeeklyUsd != null && onChainWeeklyUsd > 0) return onChainWeeklyUsd;
  return DEFAULT_SETTINGS.weeklyAmountUsd;
}

type TopPick = {
  name: string;
  score: number;
  priceNow: number | null;
  premiumPct: number | null;
  premiumSource: string;
};

type RankView = {
  top3: TopPick[];
  title: string | null;
  subtitle: string | null;
  premiumBasis: RankResult["premiumBasis"];
  rankFlat: boolean;
};

function rankView(result: RankResult, locale: string): RankView {
  return {
    top3: result.top3.slice(0, 3).map((row) => ({
      name: row.name,
      score: row.score,
      priceNow: row.token_price_usd,
      premiumPct: Number.isFinite(row.premium_pct) ? row.premium_pct : null,
      premiumSource: row.premium_source,
    })),
    title: top3TitleFromRank(result, locale),
    subtitle: result.sourceLabel || null,
    premiumBasis: result.premiumBasis,
    rankFlat: isFlatFallback(result),
  };
}

export function OverviewView() {
  const { connected, publicKey } = useWallet();
  const ownerBase58 = publicKey?.toBase58() ?? null;
  const predca = usePredca();
  const { locale, t } = useI18n();
  const [depositAmt, setDepositAmt] = useState(500);
  const [withdrawAmt, setWithdrawAmt] = useState(10);
  const [generated, setGenerated] = useState<RankView | null>(null);
  const sessionSnap = useSyncExternalStore(
    subscribeRankSession,
    rankSessionClientSnapshot,
    rankSessionServerSnapshot,
  );
  useEffect(() => {
    restoreRankSession(rankPrefsKey());
  }, []);
  useEffect(() => {
    adoptWeeklyDraftForOwner(ownerBase58);
  }, [ownerBase58]);
  const [rankBusy, setRankBusy] = useState(false);
  const [rankError, setRankError] = useState<string | null>(null);
  const [purchaseMsg, setPurchaseMsg] = useState<string | null>(null);
  const [purchaseTone, setPurchaseTone] = useState<"ok" | "fail" | "pending">("ok");
  const [purchaseNotice, setPurchaseNotice] = useState<
    (PurchaseNotice & { expectMsg: string | null }) | null
  >(null);
  /**
   * handlePurchase stores a translation key. The verdict effect below still
   * writes a finished sentence with the real setPurchaseMsg. The key stays
   * visible only while purchaseMsg is still the anchor this handler wrote.
   * A later effect write (a different string, including null) wins.
   */
  function showPurchase(notice: PurchaseNotice | null, anchor: string | null = null) {
    if (notice == null) {
      setPurchaseNotice(null);
      return;
    }
    setPurchaseMsg(anchor);
    setPurchaseNotice({ ...notice, expectMsg: anchor });
  }
  const [buyPreview, setBuyPreview] = useState<string | null>(null);
  /** Sync lock across setWeeklyBudget and simulateBuy. A second Kup returns immediately. */
  const buyInFlightRef = useRef(false);
  const [buyInFlight, setBuyInFlight] = useState(false);
  const sawPendingSig = useRef(false);
  const dupCheckRef = useRef(false);
  const [dupChecking, setDupChecking] = useState(false);
  const [dupWarn, setDupWarn] = useState<{
    kind: "deposit" | "withdraw" | "buy";
    amount: number;
  } | null>(null);
  const [dupInfo, setDupInfo] = useState<{
    kind: "deposit" | "withdraw" | "buy";
    amount: number;
  } | null>(null);
  const [budgetPrompt, setBudgetPrompt] = useState<{
    from: number;
    to: number;
  } | null>(null);
  /** Last on-chain change the user already confirmed, so a dup retry does not ask again. */
  const budgetConfirmedPair = useRef<{ ls: number; chain: number } | null>(null);
  const [priceNow, setPriceNow] = useState(UI_CLOCK_AT);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const sigUnresolved = predca.pendingSignature != null;

  useEffect(() => {
    if (predca.pendingSignature) {
      sawPendingSig.current = true;
      return;
    }
    if (!sawPendingSig.current || purchaseTone !== "pending") return;
    sawPendingSig.current = false;
    const verdict = predca.lastVerdict;
    if (verdict?.verdict === "failed_expired" || verdict?.verdict === "unresolved") {
      const text =
        verdict.verdict === "failed_expired" ? FAILED_EXPIRED_MSG : UNRESOLVED_MSG;
      setPurchaseMsg(`${text} ${verdict.signature} ${explorerTxUrl(verdict.signature)}`);
      setPurchaseTone(verdict.verdict === "failed_expired" ? "fail" : "pending");
      return;
    }
    if (predca.error && isOnChainSignatureReject(predca.error)) {
      setPurchaseMsg(`${t("msg.purchaseFail")}: ${predca.error}`);
      setPurchaseTone("fail");
    } else {
      setPurchaseMsg(null);
      setPurchaseTone("ok");
    }
  }, [predca.pendingSignature, predca.error, predca.lastVerdict, purchaseTone, t]);
  const [faucetBusy, setFaucetBusy] = useState(false);
  const [faucetMsg, setFaucetMsg] = useState<string | null>(null);
  const [faucetErr, setFaucetErr] = useState<string | null>(null);

  async function onClaimFaucet() {
    if (predca.pendingSignatureNow()) return;
    if (!publicKey) {
      setFaucetErr(t("faucet.needWallet"));
      return;
    }
    setFaucetBusy(true);
    setFaucetMsg(null);
    setFaucetErr(null);
    try {
      const res = await claimFaucetUsdc(publicKey.toBase58());
      const sigShort =
        res.signature.length > 16
          ? `${res.signature.slice(0, 8)}…${res.signature.slice(-8)}`
          : res.signature;
      const solPart =
        res.solSkipped
          ? " (SOL skipped)"
          : res.solSignature
            ? ` · SOL ${res.solSignature.length > 16 ? `${res.solSignature.slice(0, 8)}…${res.solSignature.slice(-8)}` : res.solSignature}`
            : "";
      setFaucetMsg(
        t("faucet.success", { sig: `${sigShort}${solPart}` }) +
          " " +
          t("faucet.nextSteps"),
      );
      await predca.refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setFaucetErr(t("faucet.error", { error: msg }));
    } finally {
      setFaucetBusy(false);
    }
  }


  // Bump after adoptWeeklyDraftForOwner writes, so this read sees the scoped amount.
  const weeklyRev = useSyncExternalStore(
    subscribeWeeklyBudget,
    weeklyBudgetRevision,
    weeklyBudgetServerRevision,
  );
  const lsWeekly = readWeeklyBudgetUsd(
    DEFAULT_SETTINGS.weeklyAmountUsd,
    weeklyRev < 0 ? null : ownerBase58,
  );
  const purchaseAmount = resolvePurchaseAmount(predca.weeklyBudgetUsd, ownerBase58);
  const budgetDirty = budgetsDiffer(lsWeekly, predca.weeklyBudgetUsd);
  const onChainReady = predca.status === "ready";
  const onChainVaultUsdc =
    onChainReady && predca.vaultUsdc != null ? predca.vaultUsdc : null;
  // Funding: tylko vault on-chain. Przed Connect / bez config → null.
  const availableVaultUsdc = onChainVaultUsdc;

  // Przed Connect: zawsze puste / „—”, nigdy losowe mocki.
  const displaySol =
    connected && predca.solBalance != null ? predca.solBalance : null;
  const displayOwnerUsdc =
    connected && predca.ownerUsdc != null ? predca.ownerUsdc : null;
  const portfolioTile = portfolioTileState({
    priceWarning: predca.priceWarning,
    balanceWarning: predca.balanceWarning,
    positions: predca.positions,
  });
  const portfolioUnknown = connected && portfolioTile.unknown;
  const portfolioPriceUnknown = connected && portfolioTile.priceUnknown;
  const portfolioBalanceStale = connected && portfolioTile.balancesStale;
  const displayPortfolioUsd =
    connected && !portfolioUnknown && predca.portfolioUsd != null
      ? predca.portfolioUsd
      : null;

  // Connected: on-chain ATAs for ALL mints in devnet-mock-mints (via allMockMints).
  // Disconnected: holdings stay empty; never render the mock allocation pie.
  const displayHoldings: Holding[] = connected ? predca.holdingsOnChain : [];

  const displayLastPurchase: Purchase | null = (() => {
    if (!connected || !onChainReady || !predca.lastPurchaseOnChain) {
      return null;
    }
    const lp = predca.lastPurchaseOnChain;
    return {
      date: lp.date,
      amountUsd: lp.amountUsd,
      tokens: lp.tokens,
      perTokenUsd: lp.perTokenUsd,
      tokenAmounts: lp.tokenAmounts,
      signature: `run#${lp.runIndex}`,
    };
  })();

  async function handleGenerateRecommendations() {
    setRankError(null);
    showPurchase(null);
    setPurchaseMsg(null);
    setRankBusy(true);
    try {
      const productsResult = await fetchPrestocksProducts(
        predca.jupPrices.fetchedAt > 0 ? predca.jupPrices : undefined,
      );
      const result = await runRankingNow(productsResult);
      if (result.error && (!result.top3 || result.top3.length === 0)) {
        throw new Error(result.error);
      }
      setGenerated(rankView(result, locale));
      const notes: string[] = [];
      if (productsResult.dataSource === "snapshot") {
        notes.push(
          t("prestocks.snapshotDated", { date: PRESTOCKS_SNAPSHOT_DATE }),
        );
      } else if (productsResult.errorKey) {
        notes.push(
          t(
            productsResult.errorKey,
            fillNoticeVars(productsResult.errorVars, t),
          ),
        );
      } else if (productsResult.errorPl) {
        notes.push(productsResult.errorPl);
      }
      if (result.error) notes.push(result.error);
      if (notes.length) setRankError(notes.join(" "));
    } catch (e) {
      setRankError(e instanceof Error ? e.message : String(e));
    } finally {
      setRankBusy(false);
    }
  }

  function markPendingPurchase(): boolean {
    const sig = predca.pendingSignatureNow();
    if (!sig) return false;
    const url = explorerTxUrl(sig);
    const text = t("msg.purchasePending", { sig, url });
    showPurchase({ key: "msg.purchasePending", vars: { sig, url } }, text);
    setPurchaseTone("pending");
    return true;
  }

  async function allowDuplicate(
    kind: "deposit" | "withdraw" | "buy",
    amount: number,
    acknowledged: boolean,
  ): Promise<boolean> {
    setDupInfo(null);
    const rec = predca.unresolvedFor(kind);
    if (!rec) {
      if (dupWarn?.kind === kind) setDupWarn(null);
      return true;
    }
    const step = nextDuplicateStep({
      unresolvedSameFamily: true,
      recheckedVerdict: acknowledged ? "unresolved" : null,
      acknowledged,
    });
    if (step === "proceed") {
      setDupWarn(null);
      return true;
    }
    if (step === "warn") {
      setDupWarn({ kind, amount });
      return false;
    }
    const verdict = await predca.recheckUnresolved(rec.signature);
    if (dupOutcomeMessage(verdict) === "dup.prevConfirmed") {
      setDupInfo({ kind, amount });
      return false;
    }
    if (verdict === "unresolved") {
      setDupWarn({ kind, amount });
      return false;
    }
    setDupWarn(null);
    return true;
  }

  async function submitDeposit(acknowledged = false) {
    if (depositPresentation !== "enabled") return;
    if (predca.pendingSignatureNow()) return;
    if (!tryEnterDupCheck(dupCheckRef)) return;
    setDupChecking(true);
    try {
      const amt =
        ownerUsdcCap != null ? Math.min(depositAmt, ownerUsdcCap) : depositAmt;
      if (!(await allowDuplicate("deposit", amt, acknowledged))) return;
      await predca.depositUsdc(
        amt,
        predca.status === "no_config" ? purchaseAmount : undefined,
      );
    } finally {
      leaveDupCheck(dupCheckRef);
      setDupChecking(false);
    }
  }

  async function submitWithdraw(acknowledged = false) {
    if (withdrawPresentation !== "enabled") return;
    if (predca.pendingSignatureNow()) return;
    if (!tryEnterDupCheck(dupCheckRef)) return;
    setDupChecking(true);
    try {
      const amt =
        vaultUsdcCap != null ? Math.min(withdrawAmt, vaultUsdcCap) : withdrawAmt;
      if (!(await allowDuplicate("withdraw", amt, acknowledged))) return;
      await predca.withdrawUsdc(amt);
    } finally {
      leaveDupCheck(dupCheckRef);
      setDupChecking(false);
    }
  }

  function dupNotice(kind: "deposit" | "withdraw" | "buy", amount: number) {
    if (kind === "deposit" && depositPresentation === "disabled") return null;
    if (kind === "withdraw" && withdrawPresentation === "disabled") return null;
    if (dupWarn?.kind !== kind || dupWarn.amount !== amount) return null;
    if (!predca.unresolvedFor(kind)) return null;
    const action =
      kind === "withdraw"
        ? t("dup.action.withdraw")
        : kind === "buy"
          ? t("dup.action.buy")
          : t("dup.action.deposit");
    return (
      <div className="mt-2 rounded border border-[#fbbf2433] bg-[#fbbf2411] px-3 py-2 text-xs text-[#fbbf24]">
        <p>{t("dup.warn", { action, amount: formatDollars(amount) })}</p>
        <button
          type="button"
          disabled={dupChecking || predca.rechecking}
          onClick={() => {
            if (kind === "buy") void handlePurchase(true);
            else if (kind === "withdraw") void submitWithdraw(true);
            else void submitDeposit(true);
          }}
          className="mt-2 rounded border border-current px-2 py-1 text-[10px] uppercase tracking-wider disabled:opacity-40"
        >
          {t("dup.sendAnyway")}
        </button>
      </div>
    );
  }

  function dupInfoNotice(kind: "deposit" | "withdraw" | "buy", amount: number) {
    if (dupInfo?.kind !== kind || dupInfo.amount !== amount) return null;
    const action =
      kind === "withdraw"
        ? t("dup.action.withdraw")
        : kind === "buy"
          ? t("dup.action.buy")
          : t("dup.action.deposit");
    return (
      <div className="mt-2 rounded border border-[#fbbf2433] bg-[#fbbf2411] px-3 py-2 text-xs text-[#fbbf24]">
        <p>{t("dup.prevConfirmed", { action })}</p>
      </div>
    );
  }

  function acceptBudgetAndBuy() {
    const prompt = budgetPrompt;
    if (!prompt) return;
    budgetConfirmedPair.current = { ls: prompt.to, chain: prompt.from };
    setBudgetPrompt(null);
    void handlePurchase(false, true);
  }

  async function handlePurchase(acknowledged = false, budgetConfirmed = false) {
    if (!connected) return;
    const lsAmountNow = readWeeklyBudgetUsd(
      DEFAULT_SETTINGS.weeklyAmountUsd,
      ownerBase58,
    );
    const chainNow = predca.weeklyBudgetUsd;
    const remembered = budgetConfirmedPair.current;
    const alreadyConfirmed =
      budgetConfirmed ||
      (remembered != null &&
        chainNow != null &&
        Math.abs(remembered.ls - lsAmountNow) <= BUDGET_EPS &&
        Math.abs(remembered.chain - chainNow) <= BUDGET_EPS);
    if (
      onChainReady &&
      chainNow != null &&
      needsBudgetConfirm(lsAmountNow, chainNow, alreadyConfirmed)
    ) {
      setBudgetPrompt({ from: chainNow, to: lsAmountNow });
      return;
    }
    if (!tryEnterDupCheck(dupCheckRef)) return;
    setDupChecking(true);
    let allowed = false;
    try {
      const intendedPreview = resolvePurchaseAmount(predca.weeklyBudgetUsd, ownerBase58);
      allowed = await allowDuplicate("buy", intendedPreview, acknowledged);
    } finally {
      leaveDupCheck(dupCheckRef);
      setDupChecking(false);
    }
    if (!allowed) return;
    if (
      !tryEnterManualBuy(
        buyInFlightRef,
        predca.txPending || predca.pendingSignatureNow() != null,
      )
    ) {
      return;
    }
    setBuyInFlight(true);
    try {
      setPurchaseTone("ok");
      if (top3.length === 0) {
        setPurchaseTone("fail");
        showPurchase({ key: "msg.noRecs" });
        return;
      }

      const tokenNames = top3.slice(0, 3).map((r) => r.name);
      // LS is SoT for intended amount (sync on-chain before simulate_buy_v2 when dirty).
      const intendedAmount = resolvePurchaseAmount(predca.weeklyBudgetUsd, ownerBase58);

      // Prefer on-chain simulate_buy_v2 when Predca is ready.
      if (onChainReady) {
        if (
          availableVaultUsdc == null ||
          !Number.isFinite(availableVaultUsdc) ||
          availableVaultUsdc < intendedAmount
        ) {
          setPurchaseTone("fail");
          showPurchase({
            key: "msg.vaultLowOnChain",
            vars: {
              have: formatDollars(availableVaultUsdc ?? 0),
              need: formatDollars(intendedAmount),
            },
          });
          return;
        }

        // simulate_buy_v2 spends on-chain weeklyBudgetUsdc — sync LS → chain first.
        const lsAmount = readWeeklyBudgetUsd(DEFAULT_SETTINGS.weeklyAmountUsd, ownerBase58);
        if (budgetsDiffer(lsAmount, predca.weeklyBudgetUsd)) {
          setPurchaseTone("pending");
          showPurchase({ key: "msg.updatingBudget" });
          const budgetSig = await predca.setWeeklyBudget(lsAmount);
          if (!budgetSig) {
            if (markPendingPurchase()) return;
            const err = predca.lastTxError();
            if (err) {
              setPurchaseTone("fail");
              showPurchase({ key: "msg.budgetSyncFail", detail: err });
            } else {
              showPurchase(null);
              setPurchaseMsg(null);
            }
            return;
          }
          // setWeeklyBudget's withTx already refreshed; simulateBuy re-fetches budget.
        }

        showPurchase(null);
        setPurchaseMsg(null);
        const sig = await predca.simulateBuy(tokenNames);
        if (sig) {
          setPurchaseTone("ok");
          showPurchase({
            key: "msg.purchaseOk",
            vars: {
              sig: sig.slice(0, 8),
              amount: formatGrouped(intendedAmount, { min: 2, max: 2 }),
              tokens: tokenNames.join(" · "),
            },
            withPreview: buyPreview != null,
          });
        } else if (!markPendingPurchase()) {
          const err = predca.lastTxError();
          if (err) {
            setPurchaseTone("fail");
            showPurchase({ key: "msg.purchaseFail", detail: err });
          }
        }
        return;
      }
    } finally {
      leaveManualBuy(buyInFlightRef);
      setBuyInFlight(false);
    }
  }

  const depositPresentation = depositUi(predca.status, connected, !!predca.mint);
  const canDeposit = depositPresentation === "enabled";
  const ownerUsdcCap =
    displayOwnerUsdc != null && Number.isFinite(displayOwnerUsdc)
      ? displayOwnerUsdc
      : null;
  const vaultUsdcCap =
    onChainVaultUsdc != null && Number.isFinite(onChainVaultUsdc)
      ? onChainVaultUsdc
      : null;
  const depositOverCap =
    ownerUsdcCap != null &&
    Number.isFinite(depositAmt) &&
    depositAmt > ownerUsdcCap;
  const withdrawOverCap =
    vaultUsdcCap != null &&
    Number.isFinite(withdrawAmt) &&
    withdrawAmt > vaultUsdcCap;
  const depositDisabled =
    sigUnresolved ||
    predca.txPending ||
    dupChecking ||
    predca.rechecking ||
    !canDeposit ||
    !Number.isFinite(depositAmt) ||
    depositAmt <= 0 ||
    depositOverCap;
  const withdrawPresentation = withdrawUi(predca.status, predca.config != null);
  const withdrawDisabled =
    sigUnresolved ||
    predca.txPending ||
    dupChecking ||
    predca.rechecking ||
    !Number.isFinite(withdrawAmt) ||
    withdrawAmt <= 0 ||
    withdrawOverCap ||
    withdrawPresentation === "disabled";
  const showWithdraw = withdrawPresentation !== "hidden";
  const restored = generated ? null : parseRankSession(sessionSnap.raw, rankPrefsKey());
  const active = generated ?? (restored ? rankView(restored.rank, locale) : null);
  const top3 = active?.top3 ?? [];
  const top3Names = top3.map((row) => row.name).join("\u0001");
  // previewBuy is a useCallback (no `this`). Depend on it, not the whole predca object.
  const previewBuy = predca.previewBuy;
  const previewNames = top3Names ? top3Names.split("\u0001") : [];
  const previewGateOpen =
    connected && onChainReady && previewNames.length >= 3;
  // Hide the stored quote while the gate is closed, without writing state in the effect.
  const shownBuyPreview = previewGateOpen ? buyPreview : null;
  useEffect(() => {
    const names = top3Names ? top3Names.split("\u0001") : [];
    if (!connected || !onChainReady || names.length < 3) {
      // Drop the stored quote after paint so a later reconnect does not flash it.
      queueMicrotask(() => {
        setBuyPreview((prev) => (prev == null ? prev : null));
      });
      return;
    }
    let cancel = false;
    void previewBuy(names).then((legs) => {
      if (cancel) return;
      if (legs.length === 0) {
        setBuyPreview(null);
        return;
      }
      setBuyPreview(
        t("buy.preview", {
          legs: legs
            .map((leg) =>
              t("buy.previewLeg", {
                tokens: formatGrouped(leg.tokens, { max: 6 }),
                name: leg.name,
                price: fmtUsdAmount(leg.priceUsd, locale) ?? "",
              }),
            )
            .join(" · "),
        }),
      );
    });
    return () => {
      cancel = true;
    };
  }, [connected, onChainReady, top3Names, previewBuy, locale, t]);
  const top3Title = active?.title ?? null;
  const top3Subtitle = active?.subtitle ?? null;
  const premiumBasis = active?.premiumBasis ?? null;
  const rankFlat = active?.rankFlat ?? false;
  const restoredClock = restored
    ? fmtPriceClock(restored.savedAt, priceNow, locale)
    : "";
  const vaultTooLow =
    availableVaultUsdc == null ||
    !Number.isFinite(availableVaultUsdc) ||
    availableVaultUsdc < purchaseAmount;
  // Manual Buy must NOT disable because keeper/auto-buy phase is "buying".
  // Only this click, the user's own tx, missing recs, vault low, or not ready.
  const purchaseDisabled =
    sigUnresolved ||
    buyInFlight ||
    top3.length === 0 ||
    rankFlat ||
    predca.txPending ||
    (onChainReady
      ? vaultTooLow
      : connected
        ? true // connected but not ready → disable until ready
        : vaultTooLow);

  /** Why Purchase stays gray — shown next to the button (vault check kept). */
  const purchaseDisabledReason: string | null = (() => {
    const key = purchaseDisabledReasonKey({
      purchaseDisabled,
      sigUnresolved,
      buyInFlight,
      txPending: predca.txPending,
      statusError: predca.status === "error",
      rankFlat,
      top3Empty: top3.length === 0,
      connected,
      onChainReady,
      vaultTooLow,
    });
    if (key == null) return null;
    if (key === "purchase.disabled.rpcError") return t("purchase.disabled.rpcError");
    if (key === "purchase.disabled.flatRanking") return t("purchase.disabled.flatRanking");
    if (key === "purchase.disabled.noRecs") return t("purchase.disabled.noRecs");
    if (key === "purchase.disabled.vaultLow") {
      return t("purchase.disabled.vaultLow", {
        have: formatDollars(availableVaultUsdc ?? 0),
        need: formatDollars(purchaseAmount),
      });
    }
    return t(key);
  })();

  function fmtTile(value: number | null, digits = 2): string {
    if (value == null || !Number.isFinite(value)) return "—";
    return formatGrouped(value, { min: digits, max: digits });
  }

  function fmtMoney(value: number | null, digits = 2): string {
    if (value == null || !Number.isFinite(value)) return "—";
    return formatDollars(value, digits);
  }

  function premiumText(name: string): {
    text: string;
    tone: PremiumTone;
    tooltipKey: string;
    labelKey: string;
  } {
    const pct = livePremiumPct(name, predca.jupPrices);
    const stale =
      predca.jupPrices.source === "cache" ||
      predca.jupPrices.carried.some(
        (rowName) => canonicalName(rowName) === canonicalName(name),
      );
    const copy = premiumCopy(name, pct, stale, "inline");
    const text =
      copy.withPct && pct != null
        ? t(copy.textKey, { pct: formatPremiumPct(pct, locale) })
        : t(copy.textKey);
    return {
      text,
      tone: copy.tone,
      tooltipKey: copy.tooltipKey,
      labelKey: copy.labelKey,
    };
  }

  const pricesReady = predca.jupPrices.fetchedAt > 0;
  const anyTokenPrice = Object.values(predca.jupPrices.quotes).some(
    (q) => q.usdPrice != null,
  );
  const priceClock = pricesReady
    ? fmtPriceClock(predca.jupPrices.fetchedAt, priceNow, locale)
    : "";
  const allAtCost =
    predca.positions.length > 0 &&
    predca.positions.every(
      (row) => row.basis === "cost" && row.valueKnown !== false,
    );
  const showPnl = connected && predca.positions.length > 0;

  const vaultStat =
    predca.status === "error" && predca.vaultUsdc != null
      ? predca.vaultUsdc
      : onChainVaultUsdc;

  const statusReason =
    predca.status === "loading"
      ? t("predca.status.loading")
      : predca.status === "no_mint"
        ? t("predca.status.no_mint")
        : predca.status === "disconnected"
          ? t("predca.status.disconnected")
          : t("predca.status.error");

  const purchaseFromNotice =
    purchaseNotice != null && purchaseMsg === purchaseNotice.expectMsg;
  const purchaseText = purchaseFromNotice
    ? renderPurchaseNotice(
        purchaseNotice,
        t,
        purchaseNotice.withPreview ? shownBuyPreview : null,
      )
    : purchaseMsg;
  const purchaseClass = purchaseMsgClass(
    purchaseMsgTone(purchaseTone, purchaseText ?? ""),
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-[0.2em] text-[#a78bfa]">
            {t("overview.kicker")}
          </p>
          <h1 className="mt-1 text-xl font-semibold text-[#e8eef5]">
            {t("overview.title")}
          </h1>
        </div>
        {!connected && (
          <p className="text-xs text-[#8b95a8]">
            {t("overview.disconnectedHint", { cluster: clusterShortPl() })}
          </p>
        )}
        {connected && predca.status === "no_mint" && (
          <p className="text-xs text-[#fbbf24]">
            {t("overview.noMintHint")}
          </p>
        )}
        {connected && onChainReady && (
          <p className="text-xs text-[#2dd4bf]">
            {t("overview.onChainHint", { cluster: clusterShortPl() })}
          </p>
        )}
      </div>

      {/* On-chain Predca strip */}
      <section className="rounded-lg border border-[#2dd4bf33] bg-[#141820] p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-[11px] uppercase tracking-[0.15em] text-[#2dd4bf]">
              {t("predca.title", { cluster: clusterShortPl() })}
            </h2>
            <p className="mt-0.5 text-[10px] text-[#8b95a8]">
              {t("predca.rpc")}{" "}
              <span className="mono-num text-[#c5cedb]">{rpcHost()}</span>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {connected && publicKey && (
              <button
                type="button"
                onClick={() => void onClaimFaucet()}
                disabled={faucetBusy || predca.txPending || sigUnresolved}
                className="rounded border border-[#fbbf2444] bg-[#0c0e12] px-2.5 py-1 text-[10px] uppercase tracking-wider text-[#fbbf24] hover:bg-[#fbbf2411] disabled:opacity-40"
              >
                {faucetBusy ? t("faucet.busy") : t("faucet.button")}
              </button>
            )}
            <button
              type="button"
              onClick={() => void predca.refresh()}
              disabled={!connected || predca.loading}
              className="rounded border border-[#1e2633] px-2 py-1 text-[10px] uppercase tracking-wider text-[#8b95a8] hover:text-[#e8eef5] disabled:opacity-40"
            >
              {predca.loading ? t("predca.loading") : t("predca.refresh")}
            </button>
          </div>
        </div>
        {(faucetMsg || faucetErr) && (
          <div className="mb-3 space-y-1">
            {faucetMsg && (
              <p className="text-[10px] text-[#2dd4bf]">{faucetMsg}</p>
            )}
            {faucetErr && (
              <p className="text-[10px] text-[#f87171]">{faucetErr}</p>
            )}
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label={t("predca.budget")}
            value={
              budgetDirty
                ? formatUsd(purchaseAmount)
                : predca.weeklyBudgetUsd != null
                  ? formatUsd(predca.weeklyBudgetUsd)
                  : predca.status === "no_config"
                    ? formatUsd(purchaseAmount)
                    : "—"
            }
            unit={
              budgetDirty && predca.weeklyBudgetUsd != null
                ? `chain ${formatUsd(predca.weeklyBudgetUsd)}`
                : ""
            }
          />
          <Stat
            label={t("predca.vault")}
            value={vaultStat != null ? formatUsd(vaultStat) : "—"}
            unit={
              predca.status === "error" && predca.vaultUsdc != null
                ? t("overview.rpcStale")
                : ""
            }
          />
          {depositPresentation !== "hidden" && (
            <div
              className="rounded border border-[#1e2633] bg-[#0c0e12] p-3"
              title={
                depositPresentation === "disabled"
                  ? t("predca.rpcActionHint")
                  : undefined
              }
            >
              <p className="text-[10px] uppercase tracking-wider text-[#8b95a8]">
                {t("predca.depositTitle")}
              </p>
              <div className="mt-2 flex items-end gap-2">
                <input
                  type="number"
                  min={0.000001}
                  step={1}
                  max={ownerUsdcCap ?? undefined}
                  value={depositAmt}
                  onChange={(e) => {
                    if (dupWarn?.kind === "deposit") setDupWarn(null);
                    if (dupInfo?.kind === "deposit") setDupInfo(null);
                    const n = Number(e.target.value);
                    if (!Number.isFinite(n)) {
                      setDepositAmt(n);
                      return;
                    }
                    if (ownerUsdcCap != null && n > ownerUsdcCap) {
                      setDepositAmt(ownerUsdcCap);
                      return;
                    }
                    setDepositAmt(n);
                  }}
                  disabled={predca.txPending || sigUnresolved || !canDeposit}
                  className="mono-num min-w-0 flex-1 rounded border border-[#1e2633] bg-[#0c0e12] px-2 py-1.5 text-sm text-[#2dd4bf] outline-none focus:border-[#2dd4bf66] disabled:opacity-40"
                />
                <button
                  type="button"
                  disabled={depositDisabled}
                  onClick={() => {
                    void submitDeposit(false);
                  }}
                  className="rounded border border-[#2dd4bf44] bg-[#0c0e12] px-3 py-1.5 text-[10px] uppercase tracking-wider text-[#2dd4bf] hover:bg-[#2dd4bf11] disabled:opacity-40"
                >
                  {t("predca.deposit")}
                </button>
              </div>
              {depositPresentation === "disabled" ? (
                <p className="mt-2 text-[10px] text-[#8b95a8]">
                  {t("predca.rpcActionHint")}
                </p>
              ) : null}
              {dupNotice("deposit", ownerUsdcCap != null ? Math.min(depositAmt, ownerUsdcCap) : depositAmt)}
              {dupInfoNotice("deposit", ownerUsdcCap != null ? Math.min(depositAmt, ownerUsdcCap) : depositAmt)}
            </div>
          )}
          {showWithdraw && (
            <div
              className="rounded border border-[#1e2633] bg-[#0c0e12] p-3"
              title={
                withdrawPresentation === "disabled"
                  ? t("predca.rpcActionHint")
                  : undefined
              }
            >
              <p className="text-[10px] uppercase tracking-wider text-[#8b95a8]">
                {t("predca.withdrawTitle")}
              </p>
              <div className="mt-2 flex items-end gap-2">
                <input
                  type="number"
                  min={0.000001}
                  step={1}
                  max={vaultUsdcCap ?? undefined}
                  value={withdrawAmt}
                  onChange={(e) => {
                    if (dupWarn?.kind === "withdraw") setDupWarn(null);
                    if (dupInfo?.kind === "withdraw") setDupInfo(null);
                    const n = Number(e.target.value);
                    if (!Number.isFinite(n)) {
                      setWithdrawAmt(n);
                      return;
                    }
                    if (vaultUsdcCap != null && n > vaultUsdcCap) {
                      setWithdrawAmt(vaultUsdcCap);
                      return;
                    }
                    setWithdrawAmt(n);
                  }}
                  disabled={
                    predca.txPending ||
                    sigUnresolved ||
                    withdrawPresentation === "disabled"
                  }
                  className="mono-num min-w-0 flex-1 rounded border border-[#1e2633] bg-[#0c0e12] px-2 py-1.5 text-sm text-[#a78bfa] outline-none focus:border-[#a78bfa66] disabled:opacity-40"
                />
                <button
                  type="button"
                  disabled={withdrawDisabled}
                  onClick={() => {
                    void submitWithdraw(false);
                  }}
                  className="rounded border border-[#a78bfa44] bg-[#0c0e12] px-3 py-1.5 text-[10px] uppercase tracking-wider text-[#a78bfa] hover:bg-[#a78bfa11] disabled:opacity-40"
                >
                  {t("predca.withdraw")}
                </button>
              </div>
              {withdrawPresentation === "disabled" ? (
                <p className="mt-2 text-[10px] text-[#8b95a8]">
                  {t("predca.rpcActionHint")}
                </p>
              ) : null}
              {dupNotice(
                "withdraw",
                vaultUsdcCap != null ? Math.min(withdrawAmt, vaultUsdcCap) : withdrawAmt,
              )}
              {dupInfoNotice(
                "withdraw",
                vaultUsdcCap != null ? Math.min(withdrawAmt, vaultUsdcCap) : withdrawAmt,
              )}
            </div>
          )}
        </div>

        {canDeposit && (
          <div className="mt-2 space-y-1">
            {predca.ownerUsdc == null && (
              <p className="text-[10px] text-[#fbbf24]">
                {t("predca.hintNoAta", { mint: predca.mintHint })}
              </p>
            )}
            {predca.ownerUsdc != null && predca.ownerUsdc <= 0 && (
              <p className="text-[10px] text-[#fbbf24]">
                {t("predca.hintZeroUsdc", { mint: predca.mintHint })}
              </p>
            )}
            {depositOverCap && ownerUsdcCap != null && (
              <p className="text-[10px] text-[#fbbf24]">
                {t("overview.maxDepositHint", {
                  amount: formatUsd(ownerUsdcCap),
                })}
              </p>
            )}
            {withdrawOverCap && vaultUsdcCap != null && (
              <p className="text-[10px] text-[#fbbf24]">
                {t("overview.maxWithdrawHint", {
                  amount: formatUsd(vaultUsdcCap),
                })}
              </p>
            )}
          </div>
        )}

        {connected && predca.mint && (
          <p className="mt-2 text-[10px] text-[#8b95a8]">
            {t("predca.mintLabel")}{" "}
            <span className="mono-num text-[#c5cedb]">
              {predca.mint.toBase58()}
            </span>
            {predca.ownerUsdc == null && (
              <> {t("predca.mintNoAta")}</>
            )}
          </p>
        )}

        <PrivySignWaitNotice className="mt-3" />
        {predca.sessionCheckMsg ? (
          <TxNotice message={predca.sessionCheckMsg} tone="pending" className="mt-3" />
        ) : null}
        {predca.visibleUnresolvedTxs.slice(0, 2).map((rec) => (
          <TxNotice
            key={rec.signature}
            message={`${UNRESOLVED_MSG} ${rec.signature} ${explorerTxUrl(rec.signature)}`}
            tone="pending"
            className="mt-3"
            action={{
              label: predca.rechecking ? t("tx.rechecking") : t("tx.recheck"),
              disabled: predca.rechecking,
              onClick: () => {
                void predca.recheckUnresolved(rec.signature);
              },
            }}
          />
        ))}
        {predca.visibleUnresolvedTxs.length > 2 ? (
          <p className="mt-1 text-[10px] text-[#fbbf24]">
            +{predca.visibleUnresolvedTxs.length - 2}
          </p>
        ) : null}
        {predca.pendingMsg && (
          <TxNotice message={predca.pendingMsg} tone="pending" className="mt-3" />
        )}
        {predca.status === "error" && predca.rpcError ? (
          <TxNotice message={predca.rpcError} tone="error" className="mt-3" />
        ) : null}
        {predca.error && (
          <TxNotice message={predca.error} tone="error" className="mt-3" />
        )}
        {predca.okMsg && (
          <p className="mt-3 rounded border border-[#2dd4bf33] bg-[#2dd4bf11] px-3 py-2 text-xs text-[#2dd4bf]">
            {predca.okMsg}
          </p>
        )}

        {connected && predca.status === "no_config" && canDeposit && (
          <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-[#1e2633] pt-4">
            <div className="space-y-1">
              <span className="text-[10px] uppercase tracking-wider text-[#8b95a8]">
                {t("predca.initBudget")}
              </span>
              <p className="mono-num text-sm text-[#2dd4bf]">
                {formatUsd(purchaseAmount)}
              </p>
            </div>
            <p className="w-full text-[10px] text-[#fbbf24]">
              {t("predca.initHint")}
            </p>
            <p className="w-full text-[10px] text-[#8b95a8]">
              {t("predca.rentHint")}
            </p>
          </div>
        )}

        {connected &&
          predca.status !== "ready" &&
          predca.status !== "no_config" &&
          predca.status !== "error" &&
          !canDeposit && (
          <p className="mt-4 border-t border-[#1e2633] pt-4 text-[10px] text-[#8b95a8]">
            {t("predca.depositUnavailable", { reason: statusReason })}
          </p>
        )}

        {predca.lastRun && (
          <div className="mt-4 border-t border-[#1e2633] pt-4 text-xs text-[#8b95a8]">
            <p className="mb-2 text-[10px] uppercase tracking-wider text-[#a78bfa]">
              {t("predca.lastRun")}
            </p>
            <ul className="grid gap-1 sm:grid-cols-3">
              {predca.lastRun.mints.map((m, i) => {
                const fill = predca.runFills.find(
                  (row) => row.runIndex === predca.lastRun!.runIndex.toString(),
                );
                const slot = fill?.slots?.[i] ?? null;
                const tokens = rawToDollars(predca.lastRun!.amounts[i]);
                const tokenText = formatGrouped(tokens, { max: 6 });
                return (
                <li
                  key={i}
                  title={t("predca.runMintAddress", { mint: m.toBase58() })}
                  className="rounded border border-[#1e2633] bg-[#0c0e12] px-2 py-1.5 mono-num"
                >
                  {mintLabel(m)} · {tokenText}
                  {slot ? ` · ${formatUsd(slot.price)}` : ""}
                </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>

      <div className="grid gap-3 sm:grid-cols-3">
        {[
          {
            label: t("tile.sol"),
            value: fmtTile(displaySol, 4),
            unit: "SOL",
          },
          {
            label: t("tile.usdcWallet"),
            value: fmtMoney(displayOwnerUsdc),
            unit: "",
          },
          {
            label: t("tile.portfolioPreStock"),
            value: portfolioUnknown
              ? t("runPrice.unknown")
              : fmtMoney(displayPortfolioUsd, 0),
            unit: "",
          },
        ].map((c) => (
          <div
            key={c.label}
            className="rounded-lg border border-[#1e2633] bg-[#141820] p-4 shadow-[inset_0_1px_0_#2dd4bf11]"
          >
            <p className="text-[10px] uppercase tracking-wider text-[#8b95a8]">
              {c.label}
            </p>
            <p className="mono-num mt-2 text-2xl text-[#2dd4bf]">
              {c.value}
              {c.unit ? (
                <span className="ml-1 text-xs text-[#8b95a8]">{c.unit}</span>
              ) : null}
            </p>
          </div>
        ))}
      </div>
      {connected && (
        <div className="space-y-1 text-[10px] text-[#8b95a8]">
          <p>{t("tile.portfolioHint")}</p>
          {pricesReady && <p>{t("prices.source")}</p>}
          {pricesReady && predca.jupPrices.source === "cache" && (
            <p>{t("prices.stale", { time: priceClock })}</p>
          )}
          {pricesReady && !predca.pricesLoading && !anyTokenPrice && (
            <p>{t("prices.unavailable")}</p>
          )}
          {portfolioPriceUnknown ? <p>{t("runPrice.loading")}</p> : null}
          {portfolioBalanceStale && predca.balanceWarning ? (
            <>
              <p className="text-[#fbbf24]">{t(predca.balanceWarning)}</p>
              <p className="text-[#fbbf24]">{t("portfolio.staleHint")}</p>
            </>
          ) : null}
          {connected && predca.rpcWarning ? (
            <p className="text-[#fbbf24]">{t(predca.rpcWarning)}</p>
          ) : null}
          {allAtCost &&
            !(connected && predca.positions.length > 0 && !pnlSummary(predca.positions).hasPriced) && (
              <p>{t("positions.legacyHint")}</p>
            )}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2 lg:items-stretch">
        <section className="rounded-lg border border-[#1e2633] bg-[#141820] p-5 lg:h-full">
          <h2 className="mb-4 text-[11px] uppercase tracking-[0.15em] text-[#a78bfa]">
            {connected
              ? t("holdings.titleOnChain")
              : t("holdings.titleDisconnected")}
          </h2>
          {displayHoldings.length === 0 ? (
            <p className="text-xs text-[#8b95a8]">
              {connected
                ? t("holdings.emptyConnected")
                : t("holdings.emptyDisconnected")}
            </p>
          ) : (
            <HoldingsPie holdings={displayHoldings} />
          )}
        </section>

        <div className="flex min-h-0 flex-col gap-4 lg:h-full">
          <section className="rounded-lg border border-[#1e2633] bg-[#141820] p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-[11px] uppercase tracking-[0.15em] text-[#a78bfa]">
                  {top3Title ?? t("top3.title")}
                </h2>
                {top3Subtitle ? (
                  <p className="mt-0.5 text-[10px] normal-case tracking-normal text-[#8b95a8]">
                    {top3Subtitle}
                  </p>
                ) : null}
                {restoredClock ? (
                  <p className="mt-0.5 text-[10px] normal-case tracking-normal text-[#8b95a8]">
                    {t("top3.restored", { time: restoredClock })}
                  </p>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleGenerateRecommendations()}
                  disabled={rankBusy}
                  className="rounded border border-[#a78bfa44] bg-[#0c0e12] px-2.5 py-1 text-[10px] uppercase tracking-wider text-[#a78bfa] hover:bg-[#a78bfa11] disabled:opacity-40"
                >
                  {rankBusy ? t("btn.generating") : t("btn.generate")}
                </button>
                <button
                  type="button"
                  onClick={() => void handlePurchase(false)}
                  disabled={
                    purchaseDisabled ||
                    predca.txPending ||
                    buyInFlight ||
                    sigUnresolved ||
                    dupChecking ||
                    predca.rechecking
                  }
                  className="rounded border border-[#2dd4bf66] bg-[#0c0e12] px-2.5 py-1 text-[10px] uppercase tracking-wider text-[#2dd4bf] hover:bg-[#2dd4bf11] disabled:opacity-40"
                >
                  {buyInFlight
                    ? t("btn.buying")
                    : sigUnresolved
                      ? t("btn.waiting")
                      : predca.txPending
                        ? t("btn.txPending")
                        : t("btn.purchase")}
                </button>
              </div>
            </div>
            <ol className="space-y-2">
              {top3.length === 0 && (
                <li className="rounded border border-[#1e2633] bg-[#0c0e12] px-3 py-2 text-sm text-[#8b95a8]">
                  {connected
                    ? t("empty.generateTips")
                    : t("empty.connectWallet")}
                </li>
              )}
              {top3.map((r, i) => {
                const premium = premiumText(r.name);
                return (
                <li
                  key={`${r.name}-${i}`}
                  className="rounded border border-[#1e2633] bg-[#0c0e12] px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-3 text-sm">
                      <span className="mono-num text-[#2dd4bf]">#{i + 1}</span>
                      {r.name}
                    </span>
                    <span className="mono-num text-sm text-[#a78bfa]">
                      {formatGrouped(r.score, { min: 1, max: 1 })}
                    </span>
                  </div>
                  <p className="mt-1 text-[10px] text-[#8b95a8]">
                    <span className="mono-num">
                      {t("positions.col.price")}{" "}
                      {fmtUsdAmount(
                        quoteByName(predca.jupPrices.quotes, r.name)?.usdPrice ??
                          r.priceNow,
                        locale,
                      ) ?? t("positions.noData")}
                    </span>
                    {" · "}
                    <span
                      className={PREMIUM_TONE_CLASS[premium.tone]}
                      title={t(premium.tooltipKey)}
                      aria-label={`${t(premium.labelKey)}: ${premium.text}`}
                    >
                      {premium.text}
                    </span>
                  </p>
                </li>
                );
              })}
            </ol>
            {premiumBasis ? (
              <p className="mt-3 text-[10px] normal-case leading-relaxed tracking-normal text-[#8b95a8]">
                {t(`rank.premiumBasis.${premiumBasis}`)}
              </p>
            ) : null}
            {rankError && (
              <p className="mt-3 text-xs text-[#f87171]">{rankError}</p>
            )}
            {purchaseDisabledReason && !purchaseText && (
              <p className="mt-3 rounded border border-[#fbbf2433] bg-[#fbbf2411] px-3 py-2 text-xs text-[#fbbf24]">
                {purchaseDisabledReason}
              </p>
            )}
            {budgetPrompt ? (
              <div className="mt-3 rounded border border-[#fbbf2433] bg-[#fbbf2411] px-3 py-2 text-xs text-[#fbbf24]">
                <p>
                  {t("purchase.confirmBudget", {
                    from: formatUsd(budgetPrompt.from),
                    to: formatUsd(budgetPrompt.to),
                  })}
                </p>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={acceptBudgetAndBuy}
                    className="rounded border border-current px-2 py-1 text-[10px] uppercase tracking-wider"
                  >
                    {t("btn.confirm")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setBudgetPrompt(null)}
                    className="rounded border border-current px-2 py-1 text-[10px] uppercase tracking-wider"
                  >
                    {t("btn.cancel")}
                  </button>
                </div>
              </div>
            ) : null}
            {dupNotice("buy", resolvePurchaseAmount(predca.weeklyBudgetUsd, ownerBase58))}
            {dupInfoNotice("buy", resolvePurchaseAmount(predca.weeklyBudgetUsd, ownerBase58))}
            {shownBuyPreview && (
              <p className="mt-3 text-[10px] text-[#8b95a8]">{shownBuyPreview}</p>
            )}
            <PrivySignWaitNotice className="mt-3" />
            {purchaseText && (
              <p
                className={`mt-3 break-all rounded border px-3 py-2 text-xs ${purchaseClass}`}
              >
                {txMessageWithLink(purchaseText)}
              </p>
            )}
          </section>

          <section className="relative flex min-h-[11rem] flex-1 flex-col rounded-lg border border-[#1e2633] bg-[#141820] p-5">
            <h2 className="mb-3 text-[11px] uppercase tracking-[0.15em] text-[#a78bfa]">
              {connected && onChainReady
                ? t("lastPurchase.titleOnChain")
                : connected
                  ? t("lastPurchase.titleConnected")
                  : t("lastPurchase.titleDisconnected")}
            </h2>
            <div className="flex-1 space-y-1 text-sm pb-5">
              {!displayLastPurchase || displayLastPurchase.tokens.length === 0 ? (
                <p className="text-[#8b95a8]">
                  {connected
                    ? t("lastPurchase.emptyConnected")
                    : t("lastPurchase.emptyDisconnected")}
                </p>
              ) : (
                <>
                  <p>
                    <span className="text-[#8b95a8]">{t("lastPurchase.date")} </span>
                    <span className="mono-num">{displayLastPurchase.date}</span>
                  </p>
                  <p>
                    <span className="text-[#8b95a8]">{t("lastPurchase.budget")} </span>
                    {predca.lastPurchaseOnChain?.priceKnown === false ? (
                      <span className="mono-num text-[#8b95a8]">
                        {t("runPrice.unknown")}
                      </span>
                    ) : (
                      <>
                        <span className="mono-num text-[#2dd4bf]">
                          {formatDollars(displayLastPurchase.amountUsd)}
                        </span>
                        <span className="text-[#8b95a8]">
                          {" "}
                          {t("lastPurchase.perToken", {
                            amount: formatGrouped(
                              Number(displayLastPurchase.perTokenUsd),
                              { min: 2, max: 2 },
                            ),
                          })}
                        </span>
                      </>
                    )}
                  </p>
                  {predca.lastPurchaseOnChain?.priceKnown === false ? (
                    <p className="text-[10px] text-[#8b95a8]">{t("runPrice.loading")}</p>
                  ) : null}
                  <p>
                    <span className="text-[#8b95a8]">{t("lastPurchase.bought")} </span>
                    {displayLastPurchase.tokens
                      .map((name, i) => {
                        const amt = displayLastPurchase.tokenAmounts?.[i];
                        if (amt == null || !Number.isFinite(amt)) return name;
                        const text = formatGrouped(amt, { max: 6 });
                        return `${name} × ${text}`;
                      })
                      .join(" · ")}
                  </p>
                </>
              )}
            </div>
            <span
              className="pointer-events-none absolute bottom-2 right-3 mono-num text-[10px] tabular-nums text-[#5c6578]"
              title="noir 3.0"
            >
              v{APP_VERSION}
            </span>
          </section>
        </div>
      </div>

      {showPnl && (
        <PnlSection
          rows={predca.positions}
          locale={locale}
          detailsOpen={detailsOpen}
          onToggleDetails={() => setDetailsOpen((open) => !open)}
          balancesStale={portfolioBalanceStale}
        />
      )}

      {showPnl && detailsOpen && (
        <PositionsCard
          rows={predca.positions}
          prices={predca.jupPrices}
          fmt={fmtTile}
          locale={locale}
        />
      )}

      {showPnl && detailsOpen && (
        <PricesPanel
          prices={predca.jupPrices}
          pricesLoading={predca.pricesLoading}
          pricesReady={pricesReady}
          locale={locale}
          clock={priceClock}
          now={priceNow}
          onRefresh={() => {
            setPriceNow(Date.now());
            void predca.refreshPrices();
          }}
        />
      )}
    </div>
  );
}

function statusLabel(
  flag: PriceRowFlag,
  t: (key: string, vars?: Record<string, string | number>) => string,
  clock: string,
): string {
  if (flag === "cache") return t("prices.lastRead", { time: clock });
  if (flag === "no-data") return t("positions.noData");
  if (flag === "suspect") return t("prices.suspect");
  if (flag === "low-liquidity") return t("prices.lowLiquidity");
  return t("prices.multiplier");
}

function PricesPanel({
  prices,
  pricesLoading,
  pricesReady,
  locale,
  clock,
  now,
  onRefresh,
}: {
  prices: JupPrices;
  pricesLoading: boolean;
  pricesReady: boolean;
  locale: string;
  clock: string;
  now: number;
  onRefresh: () => void;
}) {
  const { t } = useI18n();
  const loading = !pricesReady;
  const rows = priceRows(prices.quotes, prices.fetchedAt, prices);
  const badgeClock = (name: string): string => {
    const at = prices.carriedAt?.[name];
    if (at != null && Number.isFinite(at)) return fmtPriceClock(at, now, locale);
    return clock;
  };
  return (
    <section className="rounded-lg border border-[#1e2633] bg-[#141820] p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-[11px] uppercase tracking-[0.15em] text-[#a78bfa]">
          {t("prices.panelTitle")}
        </h2>
        <button
          type="button"
          onClick={onRefresh}
          disabled={pricesLoading}
          title={t("prices.refresh")}
          aria-label={t("prices.refresh")}
          className="rounded border border-[#1e2633] px-2 py-1 text-[10px] uppercase tracking-wider text-[#8b95a8] hover:text-[#e8eef5] disabled:opacity-40"
        >
          ↻
        </button>
      </div>
      {loading ? (
        <p className="text-xs text-[#8b95a8]">{t("prices.loading")}</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-[#8b95a8]">
                  <th className="py-1 pr-3 font-medium">{t("prices.col.company")}</th>
                  <th className="py-1 pr-3 font-medium">{t("prices.col.price")}</th>
                  <th className="py-1 pr-3 font-medium" title={t("premium.tooltip")}>
                    {t("prices.col.premium")}
                  </th>
                  <th className="hidden py-1 font-medium sm:table-cell">
                    {t("prices.col.status")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const renderBadges = () =>
                    row.flags.map((flag) => (
                      <Badge key={flag}>{statusLabel(flag, t, badgeClock(row.name))}</Badge>
                    ));
                  const stale = row.flags.includes("cache");
                  const copy = premiumCopy(row.name, row.premiumPct, stale, "cell");
                  const tone = copy.tone;
                  const phrase =
                    copy.withPct && row.premiumPct != null
                      ? t(copy.textKey, { pct: fmtPanelPct(row.premiumPct, locale) })
                      : t(copy.textKey);
                  return (
                    <tr key={row.name} className="border-t border-[#1e2633] align-top">
                      <td className="py-2 pr-3 text-[#c5cedb]">
                        <div>{row.name}</div>
                        {row.flags.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1 sm:hidden">{renderBadges()}</div>
                        )}
                      </td>
                      <td className="mono-num py-2 pr-3">
                        {fmtUsdAmount(row.usdPrice, locale) ?? t("positions.noData")}
                      </td>
                      <td
                        className={`mono-num py-2 pr-3 ${PREMIUM_TONE_CLASS[tone]}`}
                        title={t(copy.tooltipKey)}
                      >
                        {phrase}
                      </td>
                      <td className="hidden py-2 sm:table-cell">
                        {row.flags.length > 0 ? (
                          <div className="flex flex-wrap gap-1">{renderBadges()}</div>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[10px] text-[#8b95a8]">{t("prices.source")}</p>
        </>
      )}
    </section>
  );
}

function fmtPanelPct(value: number, locale: string): string {
  return formatPremiumPct(value, locale);
}

function PnlSection({
  rows,
  locale,
  detailsOpen,
  onToggleDetails,
  balancesStale = false,
}: {
  rows: PositionRow[];
  locale: string;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  /** Hide the USD total. It is summed from the previous token balances. */
  balancesStale?: boolean;
}) {
  const { t } = useI18n();
  const summary = pnlSummary(rows);
  const pnl = summary.pnlUsd;
  const pos = pnl != null && pnl > 0;
  const neg = pnl != null && pnl < 0;
  const pnlClass = pos ? "text-[#34d399]" : neg ? "text-[#f87171]" : "text-[#8b95a8]";
  const money = summary.hasPriced ? fmtSignedPnl(pnl, summary.pnlPct, locale) : null;
  const atCost = fmtUsdAmount(summary.unpricedCostUsd, locale);
  return (
    <section className="rounded-lg border border-[#1e2633] bg-[#141820] p-5">
      <h2 className="mb-2 text-[11px] uppercase tracking-[0.15em] text-[#a78bfa]">
        {t("pnl.title")}
      </h2>
      {balancesStale ? (
        <p className="mono-num text-sm text-[#c5cedb]">{t("runPrice.unknown")}</p>
      ) : money ? (
        <p className={`mono-num text-lg ${pnlClass}`}>
          {t("pnl.total")} {money}
        </p>
      ) : rows.some((row) => row.valueKnown === false) ? (
        <p className="mono-num text-sm text-[#c5cedb]">
          {t("runPrice.unknown")}
          <span className="mt-1 block text-[10px] text-[#8b95a8]">
            {t("runPrice.loading")}
          </span>
        </p>
      ) : (
        <p className="mono-num text-sm text-[#c5cedb]">
          {t("pnl.atCostValue", { value: atCost ?? t("positions.noData") })}
        </p>
      )}
      {summary.hasUnpricedV2 && (
        <p className="mt-1 text-[10px] text-[#8b95a8]">{t("pnl.noPriceNote")}</p>
      )}
      {rows.some((row) => row.valueKnown === false) && money ? (
        <p className="mt-1 text-[10px] text-[#8b95a8]">{t("runPrice.loading")}</p>
      ) : null}
      {!summary.hasPriced && summary.hasLegacy && (
        <p className="mt-1 text-[10px] text-[#8b95a8]">{t("pnl.legacyNote")}</p>
      )}
      {summary.hasPriced && summary.hasLegacy && (
        <p className="mt-1 text-[10px] text-[#8b95a8]">{t("pnl.partialNote")}</p>
      )}
      <button
        type="button"
        onClick={onToggleDetails}
        aria-expanded={detailsOpen}
        className="mt-3 rounded border border-[#1e2633] px-3 py-1 text-[10px] uppercase tracking-wider text-[#8b95a8] hover:text-[#e8eef5]"
      >
        {detailsOpen ? t("pnl.hideDetails") : t("pnl.details")}
      </button>
    </section>
  );
}

function PositionsCard({
  rows,
  prices,
  fmt,
  locale,
}: {
  rows: PositionRow[];
  prices: JupPrices;
  fmt: (value: number | null, digits?: number) => string;
  locale: string;
}) {
  const { t } = useI18n();
  return (
    <section className="rounded-lg border border-[#1e2633] bg-[#141820] p-5">
      <h2 className="mb-3 text-[11px] uppercase tracking-[0.15em] text-[#a78bfa]">
        {t("positions.title")}
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-[#8b95a8]">
              <th className="py-1 pr-3 font-medium">{t("positions.col.asset")}</th>
              <th className="hidden py-1 pr-3 font-medium sm:table-cell">
                {t("positions.col.units")}
              </th>
              <th className="py-1 pr-3 font-medium">{t("positions.col.price")}</th>
              <th className="py-1 pr-3 font-medium">{t("positions.col.value")}</th>
              <th className="hidden py-1 pr-3 font-medium sm:table-cell">
                {t("positions.col.avgBuy")}
              </th>
              <th className="py-1 font-medium">{t("positions.col.pnl")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const quote = quoteByName(prices.quotes, row.name);
              const suspect = prices.suspect.some(
                (name) => canonicalName(name) === canonicalName(row.name),
              );
              const priceStale =
                prices.source === "cache" ||
                prices.carried.some(
                  (name) => canonicalName(name) === canonicalName(row.name),
                );
              const discountPct = livePremiumPct(row.name, prices);
              const discount = premiumCopy(row.name, discountPct, priceStale, "cell");
              const discountText =
                discount.withPct && discountPct != null
                  ? t(discount.textKey, { pct: formatPremiumPct(discountPct, locale) })
                  : t(discount.textKey);
              const pnlPos = row.pnlUsd != null && row.pnlUsd > 0;
              const pnlNeg = row.pnlUsd != null && row.pnlUsd < 0;
              let pnlClass = "text-[#8b95a8]";
              if (pnlPos) pnlClass = "text-[#34d399]";
              else if (pnlNeg) pnlClass = "text-[#f87171]";
              const lowLiq = Boolean(quote && isLowLiquidity(quote));
              const valueUnknown = row.valueKnown === false;
              const showBadges =
                (row.basis === "cost" && !valueUnknown) ||
                valueUnknown ||
                suspect ||
                lowLiq ||
                Boolean(quote?.multiplierChange);
              return (
                <tr key={row.name} className="border-t border-[#1e2633] align-top">
                  <td className="py-2 pr-3 text-[#c5cedb]">
                    <div>{row.name}</div>
                    {showBadges && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {row.basis === "cost" && !valueUnknown && (
                          <Badge>{t("positions.atCost")}</Badge>
                        )}
                        {valueUnknown && <Badge>{t("runPrice.loading")}</Badge>}
                        {suspect && <Badge>{t("prices.suspect")}</Badge>}
                        {lowLiq && <Badge>{t("prices.lowLiquidity")}</Badge>}
                        {quote?.multiplierChange && (
                          <Badge>{t("prices.multiplier")}</Badge>
                        )}
                      </div>
                    )}
                    {row.mismatch && (
                      <p className="mt-1 text-[10px] text-[#fbbf24]">
                        {t("positions.mismatch")}
                      </p>
                    )}
                    {showsSpacexDiscount(row.name) && (
                      <p
                        className={`mt-1 ${PREMIUM_TONE_CLASS[discount.tone]}`}
                        title={t(discount.tooltipKey)}
                        aria-label={`${t(discount.labelKey)}: ${discountText}`}
                      >
                        {discountText}
                      </p>
                    )}
                  </td>
                  <td className="mono-num hidden py-2 pr-3 sm:table-cell">
                    {fmt(row.units, 4)}
                  </td>
                  <td className="mono-num py-2 pr-3">
                    {fmtUsdAmount(row.priceNow, locale) ?? t("positions.noData")}
                  </td>
                  <td className="mono-num py-2 pr-3 text-[#2dd4bf]">
                    {valueUnknown
                      ? t("runPrice.unknown")
                      : (fmtUsdAmount(row.valueUsd, locale) ?? t("positions.noData"))}
                  </td>
                  <td className="mono-num hidden py-2 pr-3 sm:table-cell">
                    {valueUnknown
                      ? t("runPrice.unknown")
                      : (fmtUsdAmount(row.avgBuyPrice, locale) ?? "—")}
                  </td>
                  <td className={`mono-num py-2 ${pnlClass}`}>
                    {valueUnknown ? (
                      t("runPrice.unknown")
                    ) : positionPnlKind(row) === "legacy" ? (
                      <span title={t("pnl.legacyNote")}>—</span>
                    ) : positionPnlKind(row) === "nodata" ? (
                      t("positions.noData")
                    ) : (
                      fmtSignedPnl(row.pnlUsd, row.pnlPct, locale)
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Badge({ children }: { children: string }) {
  return (
    <span className="rounded border border-[#fbbf2444] px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-[#fbbf24]">
      {children}
    </span>
  );
}

function Stat({
  label,
  value,
  unit,
}: {
  label: string;
  value: string;
  unit: string;
}) {
  return (
    <div className="rounded border border-[#1e2633] bg-[#0c0e12] p-3">
      <p className="text-[10px] uppercase tracking-wider text-[#8b95a8]">
        {label}
      </p>
      <p className="mono-num mt-1 text-lg text-[#e8eef5]">
        {value}
        {unit ? (
          <span className="ml-1 text-[10px] text-[#8b95a8]">{unit}</span>
        ) : null}
      </p>
    </div>
  );
}
