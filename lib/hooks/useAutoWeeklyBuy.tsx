"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useKeeperSignMessage } from "@/components/PrivyWalletBridge";
import {
  clearStatusAuthCache,
  keeperDisable,
  keeperEnable,
  keeperHealth,
  keeperHealthInfo,
  keeperNextBuyAtMs,
  keeperPublicStatus,
  type KeeperMode,
  type KeeperRunResult,
} from "@/lib/keeper-client";
import { rankPrefsForApi, readRankPrefs } from "@/lib/rank-prefs";
import { DEFAULT_SETTINGS, type JevRank } from "@/lib/mock-data";
import {
  AUTO_BUY_TICK_MS,
  BANNER_HOLD_MS,
  ENABLE_PENDING_POLL_MS,
  WEEK_MS,
  canCommitEnabledFromStatus,
  cleanupOwnerForFailedCycle,
  isBannerHoldActive,
  resolvePendingEnable,
  pendingEnableStillFor,
  canPostAutoEnable,
  shouldCommitAutoBuyEnabled,
  shouldPollInProgressEnable,
  shouldSendEnable,
  formatWarsawWhen,
  writeAutoBuyMeta,
  writeAutoWeeklyBuy,
  writeWeeklyBudgetUsd,
  type AutoBuyBlockReason,
  type EnableStatusBaseline,
} from "@/lib/auto-weekly-buy";
import { presentAutoBuyError } from "@/lib/auto-buy-error";
import { useI18n } from "@/lib/i18n";
import { formatDollars, formatGrouped } from "@/lib/number-format";
import { isVaultLowReason } from "@/lib/vault-low-reason";
import {
  commitLatestRef,
  useIsomorphicLayoutEffect,
} from "@/lib/hooks/useLatestRef";
import { usePredca } from "@/lib/hooks/usePredca";
import {
  applyAutoBuyActionStatus,
  autoBuyStatusIsTransitional,
  nextAutoBuyEnabled,
} from "@/lib/keeper-enabled";
import { readTypesafeKey } from "@/lib/keys";
import { unresolvedSignatureBlocksTx } from "@/lib/vault-follow-up";

export type AutoBuyPhase =
  | "idle"
  | "ranking"
  | "buying"
  | "pending"
  | "ok"
  | "error"
  | "blocked";

export type AutoWeeklyBuyApi = {
  enabled: boolean;
  setEnabled: (value: boolean) => void;
  /** Confirm-enable: start keeper (UI does not buy). */
  startCycle: (weeklyBudgetUsd: number) => Promise<void>;
  phase: AutoBuyPhase;
  blockReason: AutoBuyBlockReason | null;
  message: string | null;
  nextAt: number | null;
  nextLabel: string | null;
  lastTop3: JevRank[];
  due: boolean;
  /** From daemon /health|/status — same flag that gates real txs. */
  keeperMode: KeeperMode | null;
  /** This owner's on/off bit was read. False while the first public read is in flight or failed. */
  statusResolved: boolean;
  /** A public status read for this owner has finished. */
  statusChecked: boolean;
};

const AutoWeeklyBuyContext = createContext<AutoWeeklyBuyApi | null>(null);

/** Stable id for a keeper purchase so a new run refreshes on-chain history once. */
function keeperRunMarker(st: KeeperRunResult): string | null {
  if (typeof st.signature === "string" && st.signature.length > 0) {
    return `sig:${st.signature}`;
  }
  const ts = st.lastRunTs ?? st.last_run_ts ?? st.lastBuy ?? st.last_buy;
  if (ts == null || ts === "") return null;
  return `ts:${String(ts)}`;
}

/** Module lock — Strict Mode remounts must not double-enable. */
let cycleInFlight = false;

function useAutoWeeklyBuyImpl(): AutoWeeklyBuyApi {
  const { connected, publicKey } = useWallet();
  const signMessage = useKeeperSignMessage();
  const predca = usePredca();
  const { locale, t } = useI18n();
  const [enabled, setEnabledState] = useState(DEFAULT_SETTINGS.autoWeeklyBuy);
  const [prefsReady, setPrefsReady] = useState(false);
  const [phase, setPhase] = useState<AutoBuyPhase>("idle");
  const [blockReason, setBlockReason] = useState<AutoBuyBlockReason | null>(
    null,
  );
  const [message, setMessage] = useState<string | null>(null);
  const [nextAt, setNextAt] = useState<number | null>(null);
  const [lastTop3, setLastTop3] = useState<JevRank[]>([]);
  const [due, setDue] = useState(false);
  const [keeperMode, setKeeperMode] = useState<KeeperMode | null>(null);
  const [statusResolved, setStatusResolvedState] = useState(false);
  const statusResolvedRef = useRef(false);
  const markStatusResolved = useCallback((value: boolean) => {
    statusResolvedRef.current = value;
    setStatusResolvedState(value);
  }, []);
  const [statusChecked, setStatusChecked] = useState(false);

  const ownerKey = publicKey?.toBase58() ?? null;
  // These eight follow the latest render. The copy is a layout effect, so
  // the status effect, tick, and sign callbacks below still see this render
  // before they run. Initial values are the first render's values.
  const predcaRef = useRef(predca);
  const connectedRef = useRef(connected);
  const ownerRef = useRef(ownerKey);
  const signMessageRef = useRef(signMessage);
  const enabledRef = useRef(enabled);
  const tRef = useRef(t);
  const localeRef = useRef(locale);
  const nextAtRef = useRef(nextAt);
  useIsomorphicLayoutEffect(() => {
    commitLatestRef(predcaRef, predca);
    commitLatestRef(connectedRef, connected);
    commitLatestRef(ownerRef, ownerKey);
    commitLatestRef(signMessageRef, signMessage);
    commitLatestRef(enabledRef, enabled);
    commitLatestRef(tRef, t);
    commitLatestRef(localeRef, locale);
    commitLatestRef(nextAtRef, nextAt);
  });
  const ignoreOffUntilRef = useRef(0);
  /** Bumped on every publicKey change — ignore in-flight status/tick/startCycle. */
  const statusEpochRef = useRef(0);
  /** Previous keeper purchase marker. A change means a new on-chain run. */
  const seenKeeperRunRef = useRef<string | null>(null);
  /**
   * Epoch ms. While now < this, tick may refresh schedule/mode but must not
   * replace phase or message (startCycle ok / error / blocked).
   */
  const bannerHoldUntilRef = useRef(0);
  /** Last pubkey this effect observed. Null until the first run. */
  const prevOwnerRef = useRef<string | null>(null);
  /** /enable timed out. Tick must not replace this banner or turn the toggle off. */
  const enablePendingRef = useRef(false);
  const enablePendingOwnerRef = useRef<string | null>(null);
  const enableBaselineRef = useRef<EnableStatusBaseline | null>(null);
  /**
   * On/off from the enable or disable action. A silent status replaces it
   * only when `nextAutoBuyEnabled` says the payload is authoritative.
   */
  const actionEnabledRef = useRef<boolean | null>(null);
  /** Bumped with that bit so a read that started earlier cannot overwrite it. */
  const enabledEpochRef = useRef(0);

  const resetBannerState = useCallback(() => {
    setPhase("idle");
    setMessage(null);
    setNextAt(null);
    setLastTop3([]);
    setDue(false);
    setBlockReason(null);
    setEnabledState(false);
  }, []);

  useEffect(() => {
    const prev = prevOwnerRef.current;
    const ownerChanged = prev !== ownerKey;
    if (prev && ownerChanged) {
      // Disconnect drops every wallet. A switch drops only the one we left.
      if (!ownerKey) clearStatusAuthCache();
      else clearStatusAuthCache(prev);
    }
    prevOwnerRef.current = ownerKey;
    statusEpochRef.current += 1;
    seenKeeperRunRef.current = null;
    bannerHoldUntilRef.current = 0;
    enablePendingRef.current = false;
    enablePendingOwnerRef.current = null;
    enableBaselineRef.current = null;
    if (ownerChanged) {
      actionEnabledRef.current = null;
      enabledEpochRef.current += 1;
    }
    cycleInFlight = false;
    if (ownerKey) ignoreOffUntilRef.current = Date.now() + 2000;
    // Drop the previous owner's On immediately. Status below corrects it.
    // The first paint already starts cleared, so an unchanged owner (the
    // no-wallet mount) does not set state again. A real switch still resets
    // in this effect, before the status fetch below.
    if (ownerChanged) {
      resetBannerState();
      setPrefsReady(false);
      setKeeperMode(null);
    }
    if (ownerChanged) {
      markStatusResolved(false);
      setStatusChecked(false);
    }
  }, [ownerKey, resetBannerState]);

  useEffect(() => {
    if (!ownerKey) return;
    const epoch = statusEpochRef.current;
    let cancelled = false;
    void (async () => {
      const seenAt = enabledEpochRef.current;
      const [st, health] = await Promise.all([
        keeperPublicStatus(ownerKey),
        keeperHealthInfo(),
      ]);
      if (cancelled || statusEpochRef.current !== epoch) return;
      const modeFromStatus =
        st.mode === "live" || st.mode === "dry-run" ? st.mode : null;
      setKeeperMode(modeFromStatus ?? health.mode);
      setStatusChecked(true);
      // An enable/disable that started after this read owns the switch.
      if (enabledEpochRef.current !== seenAt) {
        setPrefsReady(true);
        return;
      }
      // Unknown status (unreachable, 404) must not force Off.
      // A transitional enabled:false must not undo the action bit.
      const next = nextAutoBuyEnabled(actionEnabledRef.current, st, ownerKey);
      if (next === true || next === false) {
        markStatusResolved(true);
        setEnabledState(next);
        writeAutoWeeklyBuy(next, ownerKey);
        if (!autoBuyStatusIsTransitional(st)) actionEnabledRef.current = next;
      }
      setPrefsReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [ownerKey]);
  const setEnabled = useCallback((value: boolean) => {
    if (!value && Date.now() < ignoreOffUntilRef.current) {
      return;
    }
    // User changed enable — release the sticky startCycle banner.
    bannerHoldUntilRef.current = 0;
    const owner = ownerRef.current;
    if (!value) {
      const sign = signMessageRef.current;
      if (!(owner && sign)) return;
      const epoch = statusEpochRef.current;
      void (async () => {
        const res = await keeperDisable(owner, sign);
        if (statusEpochRef.current !== epoch) return;
        const err = res.error ?? "";
        // Wallet closed the prompt. No keeper write happened. Leave the switch.
        if (!res.ok && err.startsWith("sign_rejected")) {
          setPhase("error");
          setMessage(tRef.current("auto.signRejected", { error: err }));
          return;
        }
        if (!res.ok) {
          // Idempotent off: keeper already off → success (no scary mismatch error).
          const st = await keeperPublicStatus(owner);
          if (statusEpochRef.current !== epoch) return;
          setStatusChecked(true);
          if (st.enabled === false) {
            enabledEpochRef.current += 1;
            actionEnabledRef.current = false;
            setEnabledState(false);
            writeAutoWeeklyBuy(false, owner);
            markStatusResolved(true);
            setPhase("idle");
            setMessage(tRef.current("auto.status.off"));
            return;
          }
          setPhase("error");
          setMessage(
            err.includes("signature") || err.includes("sign_")
              ? tRef.current("auto.signRejected", { error: err })
              : err || "Keeper disable failed",
          );
          return;
        }
        // Disable already signed once. State comes from that response.
        // The follow-up read is public: no second wallet window.
        enabledEpochRef.current += 1;
        actionEnabledRef.current = false;
        setEnabledState(false);
        writeAutoWeeklyBuy(false, owner);
        markStatusResolved(true);
        setPhase("idle");
        setBlockReason(null);
        setMessage(tRef.current("auto.status.off"));
        const st = await keeperPublicStatus(owner);
        if (statusEpochRef.current !== epoch) return;
        const patch = applyAutoBuyActionStatus(false, st);
        setStatusChecked(true);
        if (patch.touchStatusResolved) markStatusResolved(patch.statusResolved);
        actionEnabledRef.current = patch.enabled;
        setEnabledState(patch.enabled);
        writeAutoWeeklyBuy(patch.enabled, owner);
      })();
      return;
    }
    enabledEpochRef.current += 1;
    actionEnabledRef.current = value;
    setEnabledState(value);
    writeAutoWeeklyBuy(value, owner);
  }, []);

  const startCycle = useCallback(async (weeklyBudgetUsd: number) => {
    const pendingNow = predcaRef.current;
    if (
      pendingNow.txPending ||
      unresolvedSignatureBlocksTx(pendingNow.pendingSignature) ||
      unresolvedSignatureBlocksTx(pendingNow.pendingSignatureNow())
    ) {
      bannerHoldUntilRef.current = Date.now() + BANNER_HOLD_MS;
      setPhase("blocked");
      setBlockReason(null);
      setMessage(tRef.current("btn.waiting"));
      return;
    }
    const amount = Number(weeklyBudgetUsd);
    if (!Number.isFinite(amount) || amount <= 0) {
      bannerHoldUntilRef.current = Date.now() + BANNER_HOLD_MS;
      setPhase("error");
      setMessage(tRef.current("tx.err.budgetPositive"));
      return;
    }
    // Snapshot. The layout effect has already copied this render's pubkey.
    // The owner effect bumps the epoch after that. Cleanup must keep this pubkey.
    const cycleOwner = ownerRef.current;
    if (!cycleOwner) {
      bannerHoldUntilRef.current = Date.now() + BANNER_HOLD_MS;
      setPhase("blocked");
      setBlockReason("need_wallet");
      setMessage(tRef.current("auto.status.needWallet"));
      return;
    }
    if (!canPostAutoEnable(readTypesafeKey())) {
      bannerHoldUntilRef.current = Date.now() + BANNER_HOLD_MS;
      enabledEpochRef.current += 1;
      actionEnabledRef.current = false;
      setEnabledState(false);
      writeAutoWeeklyBuy(false, cycleOwner);
      setPhase("error");
      setBlockReason(null);
      setMessage(tRef.current("auto.error.jevNoKey"));
      return;
    }
    if (!shouldSendEnable(cycleInFlight)) return;
    cycleInFlight = true;
    const epoch = statusEpochRef.current;
    const stillCurrent = () => statusEpochRef.current === epoch;
    const sign = signMessageRef.current;
    try {
      if (!sign) {
        bannerHoldUntilRef.current = Date.now() + BANNER_HOLD_MS;
        setPhase("blocked");
        setBlockReason("need_wallet");
        setMessage(tRef.current("auto.needSignMessage"));
        return;
      }
      writeWeeklyBudgetUsd(amount, cycleOwner);
      const p = predcaRef.current;
      if (p.status === "error") {
        bannerHoldUntilRef.current = Date.now() + BANNER_HOLD_MS;
        setPhase("blocked");
        setBlockReason("not_ready");
        setMessage(p.rpcError ?? "");
        return;
      }
      // No UserConfig yet: do not initialize_user alone. First deposit on
      // Overview creates the account and the vault in one transaction.
      if (!p.config) {
        bannerHoldUntilRef.current = Date.now() + BANNER_HOLD_MS;
        setPhase("blocked");
        setBlockReason("not_ready");
        setMessage(
          p.status === "loading"
            ? tRef.current("auto.status.stillLoading")
            : tRef.current("auto.status.notReady"),
        );
        return;
      }
      if (p.vaultUsdc == null || !(p.vaultUsdc > 0)) {
        bannerHoldUntilRef.current = Date.now() + BANNER_HOLD_MS;
        setPhase("blocked");
        setBlockReason("vault_low");
        setMessage(tRef.current("auto.status.needVault"));
        return;
      }
      const alive = await keeperHealth();
      if (!stillCurrent()) return;
      if (!alive) {
        bannerHoldUntilRef.current = Date.now() + BANNER_HOLD_MS;
        setPhase("error");
        setMessage(tRef.current("auto.status.keeperDown"));
        return;
      }
      if (
        connectedRef.current &&
        p.mint &&
        (p.weeklyBudgetUsd == null ||
          Math.abs(p.weeklyBudgetUsd - amount) > 0.000001)
      ) {
        const sig = await p.setWeeklyBudget(amount);
        if (!stillCurrent()) return;
        if (!sig) {
          bannerHoldUntilRef.current = Date.now() + BANNER_HOLD_MS;
          setPhase("error");
          setMessage(
            predcaRef.current.lastTxError() ||
              tRef.current("auto.weeklySaveFailed"),
          );
          return;
        }
      }
      writeAutoBuyMeta(
        {
          lastAttemptMs: Date.now(),
          lastSuccessMs: 0,
          lastError: null,
          cycleStartedAtMs: Date.now(),
          cycleBudgetUsd: amount,
        },
        cycleOwner,
      );
      if (!stillCurrent()) return;
      const prior = await keeperPublicStatus(cycleOwner);
      // Enable signs once inside keeperEnable. This read never opens a prompt.
      const readStatusAfterAction = async () => {
        const st = await keeperPublicStatus(cycleOwner);
        if (!stillCurrent()) return;
        const patch = applyAutoBuyActionStatus(true, st);
        setStatusChecked(true);
        if (patch.touchStatusResolved) markStatusResolved(patch.statusResolved);
        actionEnabledRef.current = patch.enabled;
        setEnabledState(patch.enabled);
        writeAutoWeeklyBuy(patch.enabled, cycleOwner);
      };
      if (!stillCurrent()) return;
      const baseline: EnableStatusBaseline = {
        error: prior.error ?? null,
        phase: prior.phase ?? null,
      };
      const commitPurchase = (ran: KeeperRunResult) => {
        enablePendingRef.current = false;
        enablePendingOwnerRef.current = null;
        enableBaselineRef.current = null;
        bannerHoldUntilRef.current = Date.now() + BANNER_HOLD_MS;
        enabledEpochRef.current += 1;
        actionEnabledRef.current = true;
        setEnabledState(true);
        writeAutoWeeklyBuy(true, cycleOwner);
        markStatusResolved(true);
        if (ran.names && ran.names.length > 0) {
          setLastTop3(ran.names.map((name) => ({ name, score: 0 })));
        }
        writeAutoBuyMeta(
          {
            lastAttemptMs: Date.now(),
            lastSuccessMs: Date.now(),
            lastError: null,
            cycleStartedAtMs: Date.now(),
            cycleBudgetUsd: amount,
          },
          cycleOwner,
        );
        setPhase("ok");
        setDue(false);
        setBlockReason(null);
        seenKeeperRunRef.current = keeperRunMarker(ran);
        void predcaRef.current.refresh();
        const nextBuyMs = keeperNextBuyAtMs(ran) ?? Date.now() + WEEK_MS;
        setNextAt(nextBuyMs);
        const amountLabel = formatGrouped(ran.amountUsd ?? amount, {
          min: 2,
          max: 2,
        });
        const tokensLabel = (ran.names ?? []).join(" · ");
        setMessage(
          tRef.current("auto.status.okWithNext", {
            amount: amountLabel,
            tokens: tokensLabel,
            nextBuy: formatWarsawWhen(nextBuyMs, localeRef.current),
          }),
        );
      };
      // Daemon writes Off itself when enable fails. Do not ask for a second signature.
      const forceOff = async (reason: string) => {
        enablePendingRef.current = false;
        enablePendingOwnerRef.current = null;
        const cleanupOwner = cleanupOwnerForFailedCycle(
          cycleOwner,
          epoch,
          statusEpochRef.current,
        );
        if (!cleanupOwner) return;
        bannerHoldUntilRef.current = Date.now() + BANNER_HOLD_MS;
        enabledEpochRef.current += 1;
        actionEnabledRef.current = false;
        setEnabledState(false);
        writeAutoWeeklyBuy(false, cleanupOwner);
        if (statusEpochRef.current !== epoch) return;
        setPhase("error");
        const vaultish = isVaultLowReason(reason);
        setMessage(
          vaultish
            ? tRef.current("auto.status.vaultLow", {
                have: "?",
                need: formatDollars(amount),
              })
            : tRef.current("auto.status.error", { reason }),
        );
      };
      const pollPendingEnable = async () => {
        enablePendingRef.current = true;
        enablePendingOwnerRef.current = cycleOwner;
        enableBaselineRef.current = baseline;
        // Enable was accepted or is still in flight. Do not wait for the
        // purchase before showing On, and do not let the temporary Off clear it.
        enabledEpochRef.current += 1;
        actionEnabledRef.current = true;
        setEnabledState(true);
        writeAutoWeeklyBuy(true, cycleOwner);
        markStatusResolved(true);
        setPhase("pending");
        setBlockReason(null);
        setMessage(tRef.current("auto.status.enablePending"));
        const started = Date.now();
        while (stillCurrent()) {
          const st = await keeperPublicStatus(cycleOwner);
          if (!stillCurrent()) return;
          setStatusChecked(true);
          const verdict = resolvePendingEnable(
            st,
            cycleOwner,
            Date.now() - started,
            baseline,
          );
          if (verdict === "pending") {
            await new Promise((resolve) =>
              setTimeout(resolve, ENABLE_PENDING_POLL_MS),
            );
            continue;
          }
          if (verdict === "on") {
            commitPurchase(st);
            await readStatusAfterAction();
            return;
          }
          if (verdict === "off") {
            await forceOff(st.error || "enable_failed");
            return;
          }
          setPhase("pending");
          setMessage(tRef.current("auto.status.enableUnknown"));
          enablePendingRef.current = true;
          return;
        }
      };
      // Already On with a finished purchase: do not POST /enable again.
      if (canCommitEnabledFromStatus(prior, cycleOwner)) {
        commitPurchase(prior);
        await readStatusAfterAction();
        return;
      }
      // Already On and this week's buy is still in flight. Poll, do not force-buy.
      if (shouldPollInProgressEnable(prior, cycleOwner)) {
        await pollPendingEnable();
        return;
      }
      setPhase("buying");
      setMessage(tRef.current("auto.status.buyingKeeper"));
      // The switch follows the enable action now, not the purchase result.
      // Keeper writes enabled:false until the buy settles; that read is transitional.
      const enabledBefore = enabledRef.current;
      enabledEpochRef.current += 1;
      actionEnabledRef.current = true;
      setEnabledState(true);
      writeAutoWeeklyBuy(true, cycleOwner);
      markStatusResolved(true);
      // One signature: daemon syncs prefs on enable.
      const ran = await keeperEnable(
        cycleOwner,
        true,
        sign,
        rankPrefsForApi(readRankPrefs()),
      );
      if (!stillCurrent()) return;
      // Wallet closed the prompt inside keeperEnable. No POST /enable was sent.
      if (!ran.ok && String(ran.error ?? "").startsWith("sign_rejected")) {
        const reason = tRef.current("auto.signRejected", {
          error: String(ran.error ?? ""),
        });
        enabledEpochRef.current += 1;
        actionEnabledRef.current = enabledBefore;
        setEnabledState(enabledBefore);
        writeAutoWeeklyBuy(enabledBefore, cycleOwner);
        bannerHoldUntilRef.current = Date.now() + BANNER_HOLD_MS;
        setPhase("error");
        setMessage(tRef.current("auto.status.error", { reason }));
        return;
      }
      // Unknown outcome (confirm timeout, proxy timeout, busy, recent run)
      // stays on the v4.19 pending poll. Never roll the toggle Off.
      if (
        ran.pending ||
        ran.error === "enable_timeout" ||
        ran.reason === "busy" ||
        ran.reason === "confirming" ||
        ran.reason === "recent_run"
      ) {
        await pollPendingEnable();
        return;
      }
      if (!ran.ok) {
        const err = ran.error || tRef.current("auto.status.keeperDown");
        if (
          String(err).includes("signature") ||
          String(err).includes("sign_") ||
          String(err).includes("Unauthorized") ||
          String(err).includes("403") ||
          String(err).includes("401")
        ) {
          throw new Error(tRef.current("auto.signRejected", { error: String(err) }));
        }
        throw new Error(err);
      }
      // A finished purchase commits the schedule banner. ok + enabled:true
      // is already On even when the purchase fields have not arrived; a later
      // transitional status must not clear that bit. Only a real miss turns Off.
      if (!shouldCommitAutoBuyEnabled(ran) || !ran.names) {
        if (ran.enabled === true) {
          await readStatusAfterAction();
          return;
        }
        const err = ran.skipped
          ? String(ran.error || ran.reason || "purchase skipped")
          : "Keeper returned success without a completed purchase.";
        await forceOff(err);
        return;
      }
      commitPurchase(ran);
      await readStatusAfterAction();
    } catch (e) {
      enablePendingRef.current = false;
      enablePendingOwnerRef.current = null;
      const cleanupOwner = cleanupOwnerForFailedCycle(
        cycleOwner,
        epoch,
        statusEpochRef.current,
      );
      if (!cleanupOwner) return;
      const reason = e instanceof Error ? e.message : String(e);
      bannerHoldUntilRef.current = Date.now() + BANNER_HOLD_MS;
      enabledEpochRef.current += 1;
      actionEnabledRef.current = false;
      setEnabledState(false);
      writeAutoWeeklyBuy(false, cleanupOwner);
      if (statusEpochRef.current !== epoch) return;
      setPhase("error");
      const vaultish = isVaultLowReason(reason);
      setMessage(
        vaultish
          ? tRef.current("auto.status.vaultLow", {
              have: "?",
              need: "?",
            })
          : tRef.current("auto.status.error", { reason }),
      );
    } finally {
      // A wallet switch already cleared the lock. An unresolved enable keeps it
      // so Confirm cannot POST /enable again.
      if (stillCurrent() && !enablePendingRef.current) cycleInFlight = false;
    }
  }, []);

  const tick = useCallback(async () => {
    if (!prefsReady) return;
    const epoch = statusEpochRef.current;
    const seenAt = enabledEpochRef.current;
    const wallet = ownerRef.current;
    if (!wallet) return;
    const st = await keeperPublicStatus(wallet);
    if (statusEpochRef.current !== epoch) return;
    if (enabledEpochRef.current !== seenAt) return;
    setStatusChecked(true);
    const runMarker = keeperRunMarker(st);
    if (runMarker && runMarker !== seenKeeperRunRef.current) {
      seenKeeperRunRef.current = runMarker;
      void predcaRef.current.refresh();
    }
    if (st.mode === "live" || st.mode === "dry-run") {
      setKeeperMode(st.mode);
    }
    if (enablePendingRef.current) {
      if (!wallet || !pendingEnableStillFor(enablePendingOwnerRef.current, wallet)) {
        return;
      }
      const verdict = resolvePendingEnable(
        st,
        wallet,
        0,
        enableBaselineRef.current ?? undefined,
      );
      if (verdict === "on") {
        enablePendingRef.current = false;
        enablePendingOwnerRef.current = null;
        enableBaselineRef.current = null;
        cycleInFlight = false;
        bannerHoldUntilRef.current = Date.now() + BANNER_HOLD_MS;
        enabledEpochRef.current += 1;
        actionEnabledRef.current = true;
        setEnabledState(true);
        writeAutoWeeklyBuy(true, wallet);
        if (st.names && st.names.length > 0) {
          setLastTop3(st.names.map((name) => ({ name, score: 0 })));
        }
        setPhase("ok");
        setDue(false);
        setBlockReason(null);
        const nextBuyMs = keeperNextBuyAtMs(st) ?? Date.now() + WEEK_MS;
        setNextAt(nextBuyMs);
        if (st.amountUsd != null && st.names) {
          setMessage(
            tRef.current("auto.status.okWithNext", {
              amount: formatGrouped(st.amountUsd, { min: 2, max: 2 }),
              tokens: st.names.join(" · "),
              nextBuy: formatWarsawWhen(nextBuyMs, localeRef.current),
            }),
          );
        }
        void predcaRef.current.refresh();
      } else if (verdict === "off") {
        enablePendingRef.current = false;
        enablePendingOwnerRef.current = null;
        enableBaselineRef.current = null;
        cycleInFlight = false;
        bannerHoldUntilRef.current = Date.now() + BANNER_HOLD_MS;
        enabledEpochRef.current += 1;
        actionEnabledRef.current = false;
        setEnabledState(false);
        writeAutoWeeklyBuy(false, wallet);
        setPhase("error");
        setBlockReason(null);
        setMessage(
          tRef.current("auto.status.error", {
            reason: st.error || "enable_failed",
          }),
        );
      } else {
        const pendingNext = nextAutoBuyEnabled(actionEnabledRef.current, st, wallet);
        // Settled off (phase off/error) may clear the bit. enabled:false with
        // no settled phase, or a missing field, must not.
        if (pendingNext === false && !autoBuyStatusIsTransitional(st)) {
          enabledEpochRef.current += 1;
          actionEnabledRef.current = false;
          setEnabledState(false);
          writeAutoWeeklyBuy(false, wallet);
        }
      }
      return;
    }
    // The enable/disable bit wins over a transitional silent read
    // (enabled:false or no field while the purchase has not settled).
    // A settled status for this wallet may replace it. Unknown must not force Off.
    const next = nextAutoBuyEnabled(actionEnabledRef.current, st, wallet);
    // Posted /enable has not returned. Status still shows the previous off
    // (or the temporary off the daemon writes for the whole purchase).
    if (cycleInFlight && actionEnabledRef.current === true && next !== true) {
      return;
    }
    const hold = isBannerHoldActive(bannerHoldUntilRef.current, Date.now());
    if (next === true || next === false) {
      markStatusResolved(true);
      const holdBlocksOff = next === false && hold && enabledRef.current;
      if (!autoBuyStatusIsTransitional(st) && !holdBlocksOff) {
        actionEnabledRef.current = next;
      }
    }
    if (next === true && wallet && !enabledRef.current) {
      setEnabledState(true);
      writeAutoWeeklyBuy(true, wallet);
    } else if (next === false && wallet && !hold && enabledRef.current) {
      setEnabledState(false);
      writeAutoWeeklyBuy(false, wallet);
    }
    // startCycle just showed ok / error / blocked. Keeper status often still
    // says off and would replace that banner with "wyłączone".
    if (hold) {
      const heldNext = keeperNextBuyAtMs(st);
      if (heldNext != null) {
        setNextAt(heldNext);
        setDue(false);
      }
      return;
    }
    if (next === null) return;
    // In-flight enable still publishes enabled:false. Keep the buying banner.
    if (next === true && autoBuyStatusIsTransitional(st)) return;
    const on = next === true;
    if (!on) {
      setPhase("idle");
      setDue(false);
      setBlockReason("off");
      setMessage(tRef.current("auto.status.off"));
      return;
    }
    if (!st.ok && st.error === "keeper_unreachable") {
      setPhase("blocked");
      setBlockReason("not_ready");
      setMessage(tRef.current("auto.status.keeperDown"));
      return;
    }
    const keeperNextBuyMs = keeperNextBuyAtMs(st);
    const nextBuyMs =
      keeperNextBuyMs ??
      (nextAtRef.current == null
        ? keeperNextBuyAtMs(st, predcaRef.current.lastPurchaseOnChain?.ts ?? null)
        : null);
    if (nextBuyMs != null) {
      setNextAt(nextBuyMs);
      setDue(false);
    }
    // Keeper settles on not_due after a successful buy while keeping
    // signature/names/amountUsd/nextAt. Gating only on phase===ok hid the
    // OK status line in Settings + banner (fell through to local idle).
    const purchaseComplete =
      (st.phase === "ok" || st.phase === "not_due") &&
      !!st.signature &&
      st.amountUsd != null &&
      Array.isArray(st.names) &&
      st.names.length > 0;
    if (purchaseComplete || (st.phase === "ok" && st.signature)) {
      setPhase("ok");
      if (st.names && st.names.length >= 3) {
        setLastTop3(st.names.map((name) => ({ name, score: 0 })));
      }
      if (st.amountUsd != null && st.names) {
        const nextBuy = nextBuyMs ?? nextAtRef.current;
        const amountLabel = formatGrouped(st.amountUsd, { min: 2, max: 2 });
        const tokensLabel = st.names.join(" · ");
        setMessage(
          nextBuy != null
            ? tRef.current("auto.status.okWithNext", {
                amount: amountLabel,
                tokens: tokensLabel,
                nextBuy: formatWarsawWhen(nextBuy, localeRef.current),
              })
            : tRef.current("auto.status.ok", {
                amount: amountLabel,
                tokens: tokensLabel,
              }),
        );
      }
      return;
    }
    if (st.phase === "error" && st.error) {
      setPhase("error");
      setMessage(tRef.current("auto.status.error", { reason: st.error }));
      return;
    }
    if (
      st.phase === "buying" ||
      st.phase === "ranking" ||
      st.phase === "confirming"
    ) {
      setPhase("buying");
      setMessage(
        st.phase === "confirming"
          ? tRef.current("auto.banner.confirming")
          : tRef.current("auto.status.buyingKeeper"),
      );
      return;
    }
    setPhase("idle");
    setBlockReason(null);
  }, [prefsReady]);

  useEffect(() => {
    if (!prefsReady) return;
    void tick();
    const id = window.setInterval(() => {
      void tick();
    }, AUTO_BUY_TICK_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [prefsReady, enabled, tick]);

  const nextLabel =
    nextAt != null ? formatWarsawWhen(nextAt, locale) : null;

  return useMemo(
    () => ({
      enabled,
      setEnabled,
      startCycle,
      phase,
      blockReason,
      message,
      nextAt,
      nextLabel,
      lastTop3,
      due,
      keeperMode,
      statusResolved,
      statusChecked,
    }),
    [
      enabled,
      setEnabled,
      startCycle,
      phase,
      blockReason,
      message,
      nextAt,
      nextLabel,
      lastTop3,
      due,
      keeperMode,
      statusResolved,
      statusChecked,
    ],
  );
}

export function AutoWeeklyBuyProvider({ children }: { children: ReactNode }) {
  const value = useAutoWeeklyBuyImpl();
  return (
    <AutoWeeklyBuyContext.Provider value={value}>
      {children}
    </AutoWeeklyBuyContext.Provider>
  );
}

export function AutoWeeklyBuyBanner() {
  const value = useAutoWeeklyBuy();
  const { t } = useI18n();
  const errorView =
    value.phase === "error" && value.message
      ? presentAutoBuyError(value.message, t)
      : null;

  useEffect(() => {
    if (!errorView?.title) return;
    console.debug("auto-buy error", errorView.title);
  }, [errorView?.title]);

  const showBanner =
    value.phase === "ranking" ||
    value.phase === "buying" ||
    value.phase === "pending" ||
    value.phase === "error" ||
    (value.phase === "ok" && value.message != null);
  if (!showBanner || !value.message) return null;
  const text =
    value.phase === "ranking"
      ? t("auto.banner.ranking")
      : value.phase === "buying"
        ? value.message || t("auto.banner.buying")
        : (errorView?.text ?? value.message);
  return (
    <div
      role="status"
      title={errorView?.title}
      className={`border-b px-4 py-2 text-center text-xs ${
        value.phase === "error"
          ? "border-[#f8717133] bg-[#f8717111] text-[#fca5a5]"
          : value.phase === "pending"
            ? "border-[#fbbf2433] bg-[#fbbf2411] text-[#fbbf24]"
            : "border-[#2dd4bf33] bg-[#2dd4bf11] text-[#2dd4bf]"
      }`}
    >
      {text}
    </div>
  );
}

export function useAutoWeeklyBuy(): AutoWeeklyBuyApi {
  const ctx = useContext(AutoWeeklyBuyContext);
  if (!ctx) {
    throw new Error("useAutoWeeklyBuy must be used within AutoWeeklyBuyProvider");
  }
  return ctx;
}
