"use client";

import { useEffect, useState } from "react";
import { DEFAULT_SETTINGS } from "@/lib/mock-data";
import { usePredca } from "@/lib/hooks/usePredca";
import { useI18n } from "@/lib/i18n";
import {
  readExclusionsRaw,
  writeExclusionsRaw,
} from "@/lib/exclusions";
import {
  rankPrefsForApi,
  readBuyDespiteIpo,
  readDeadlineInvalid,
  readIpoPremiumMatters,
  readRankPrefs,
  writeBuyDespiteIpo,
  writeDeadlineInvalid,
  writeIpoPremiumMatters,
} from "@/lib/rank-prefs";
import { keeperHealth, keeperPushPrefs } from "@/lib/keeper-client";
import {
  readWeeklyBudgetUsd,
  writeWeeklyBudgetUsd,
} from "@/lib/auto-weekly-buy";
import { useAutoWeeklyBuy } from "@/lib/hooks/useAutoWeeklyBuy";

const LS_TYPESAFE = "prestocks.TYPESAFE_API_KEY";
const LS_XAI = "prestocks.XAI_API_KEY";

export function SettingsView() {
  const predca = usePredca();
  const autoBuy = useAutoWeeklyBuy();
  const { t } = useI18n();
  const [weekly, setWeekly] = useState(DEFAULT_SETTINGS.weeklyAmountUsd);
  const [exclusions, setExclusions] = useState(
    DEFAULT_SETTINGS.exclusions.join(", "),
  );
  const [deadlineInvalid, setDeadlineInvalid] = useState(
    DEFAULT_SETTINGS.deadlineInvalid,
  );
  const [ipoPremium, setIpoPremium] = useState(
    DEFAULT_SETTINGS.ipoPremiumMatters,
  );
  const [buyDespiteIpo, setBuyDespiteIpo] = useState(
    DEFAULT_SETTINGS.buyDespiteIpo,
  );
  const [typesafeKey, setTypesafeKey] = useState("");
  const [xaiKey, setXaiKey] = useState("");
  const [showTypesafe, setShowTypesafe] = useState(false);
  const [showXai, setShowXai] = useState(false);
  const [byokSaved, setByokSaved] = useState(false);
  const [prefsReady, setPrefsReady] = useState(false);
  const [autoConfirmOpen, setAutoConfirmOpen] = useState(false);
  useEffect(() => {
    try {
      setTypesafeKey(localStorage.getItem(LS_TYPESAFE) ?? "");
      setXaiKey(localStorage.getItem(LS_XAI) ?? "");
      setExclusions(readExclusionsRaw());
      setDeadlineInvalid(readDeadlineInvalid());
      setIpoPremium(readIpoPremiumMatters());
      setBuyDespiteIpo(readBuyDespiteIpo());
    } catch {
      /* ignore */
    } finally {
      setPrefsReady(true);
    }
  }, []);

  // Persist exclusions (debounced) so ranking reads localStorage mid-session.
  useEffect(() => {
    if (!prefsReady) return;
    const id = window.setTimeout(() => {
      writeExclusionsRaw(exclusions);
    }, 300);
    return () => window.clearTimeout(id);
  }, [exclusions, prefsReady]);

  useEffect(() => {
    if (!prefsReady) return;
    writeDeadlineInvalid(deadlineInvalid);
  }, [deadlineInvalid, prefsReady]);

  useEffect(() => {
    if (!prefsReady) return;
    writeIpoPremiumMatters(ipoPremium);
  }, [ipoPremium, prefsReady]);

  useEffect(() => {
    if (!prefsReady) return;
    writeBuyDespiteIpo(buyDespiteIpo);
  }, [buyDespiteIpo, prefsReady]);

  // UI → keeper prefs.json (IPO / deadline / premium + exclusions)
  useEffect(() => {
    if (!prefsReady) return;
    const id = window.setTimeout(() => {
      void (async () => {
        if (!(await keeperHealth())) return;
        await keeperPushPrefs(rankPrefsForApi(readRankPrefs()));
      })();
    }, 400);
    return () => window.clearTimeout(id);
  }, [deadlineInvalid, ipoPremium, buyDespiteIpo, exclusions, prefsReady]);

  useEffect(() => {
    if (!prefsReady) return;
    const id = window.setTimeout(() => {
      writeWeeklyBudgetUsd(weekly);
    }, 300);
    return () => window.clearTimeout(id);
  }, [weekly, prefsReady]);

  useEffect(() => {
    if (predca.weeklyBudgetUsd != null && predca.weeklyBudgetUsd > 0) {
      setWeekly(predca.weeklyBudgetUsd);
    }
  }, [predca.weeklyBudgetUsd]);



  useEffect(() => {
    if (!autoConfirmOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setAutoConfirmOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [autoConfirmOpen]);

  function saveByok() {
    try {
      localStorage.setItem(LS_TYPESAFE, typesafeKey.trim());
      localStorage.setItem(LS_XAI, xaiKey.trim());
      writeExclusionsRaw(exclusions);
      writeDeadlineInvalid(deadlineInvalid);
      writeIpoPremiumMatters(ipoPremium);
      writeBuyDespiteIpo(buyDespiteIpo);
      void keeperPushPrefs(rankPrefsForApi(readRankPrefs()));
      setByokSaved(true);
    } catch {
      setByokSaved(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-5">
      <div>
        <p className="text-[10px] uppercase tracking-[0.2em] text-[#a78bfa]">
          {t("settings.kicker")}
        </p>
        <h1 className="mt-1 text-2xl font-bold text-[#e8eef5]">{t("settings.title")}</h1>
        <p className="mt-1 text-xs text-[#8b95a8]">{t("settings.intro")}</p>
      </div>

      {predca.error && (
        <p className="rounded border border-[#f8717133] bg-[#f8717111] px-3 py-2 text-xs text-[#fca5a5]">
          {predca.error}
        </p>
      )}
      {predca.okMsg && (
        <p className="rounded border border-[#2dd4bf33] bg-[#2dd4bf11] px-3 py-2 text-xs text-[#2dd4bf]">
          {predca.okMsg}
        </p>
      )}

      <div className="space-y-2 rounded-lg border border-[#1e2633] bg-[#141820] p-5">
        <label className="block space-y-2">
          <span className="text-[11px] uppercase tracking-wider text-[#8b95a8]">
            {t("settings.weeklyAmount")}
          </span>
          <input
            type="number"
            min={1}
            max={10}
            step={1}
            value={weekly}
            onChange={(e) => {
              const n = Number(e.target.value);
              setWeekly(Number.isFinite(n) ? Math.min(10, Math.max(1, n)) : 1);
              predca.clearMessages();
            }}
            className="mono-num w-full rounded border border-[#1e2633] bg-[#0c0e12] px-3 py-2.5 text-base text-[#2dd4bf] outline-none focus:border-[#2dd4bf66]"
          />
          <p className="text-xs text-[#8b95a8]">
            {t("settings.weeklySplit", { amount: (weekly / 3).toFixed(2) })}
            {" "}
            {t("settings.weeklyAtEnable")}
          </p>
        </label>
        <div className="border-t border-[#1e2633] pt-4">
          <Toggle
            label={t("settings.autoWeekly")}
            checked={autoBuy.enabled}
            onChange={(v) => {
              if (v) {
                setAutoConfirmOpen(true);
                return;
              }
              autoBuy.setEnabled(false);
            }}
          />
          <p className="mt-2 text-xs leading-relaxed text-[#8b95a8] text-justify">
            {t("settings.autoWeeklyHint")}
          </p>
          {autoBuy.nextLabel && autoBuy.enabled ? (
            <p className="mt-2 text-[10px] text-[#2dd4bf]">
              {t("auto.status.next", { when: autoBuy.nextLabel })}
            </p>
          ) : null}
          {autoBuy.message && autoBuy.phase !== "idle" ? (
            <p
              className={`mt-2 text-[10px] ${
                autoBuy.phase === "error"
                  ? "text-[#fca5a5]"
                  : "text-[#8b95a8]"
              }`}
            >
              {autoBuy.message}
            </p>
          ) : null}
        </div>
      </div>

      {autoConfirmOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#0c0e12cc] px-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="auto-weekly-confirm-title"
          onClick={() => setAutoConfirmOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-lg border border-[#2dd4bf44] bg-[#141820] p-5 shadow-[0_0_40px_#2dd4bf22]"
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              id="auto-weekly-confirm-title"
              className="text-sm font-semibold text-[#e8eef5]"
            >
              {t("settings.autoWeeklyConfirmTitle")}
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-[#c5cedb] text-justify">
              {t("settings.autoWeeklyConfirmBody", {
                amount: weekly.toFixed(2),
                each: (weekly / 3).toFixed(2),
              })}
            </p>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => setAutoConfirmOpen(false)}
                className="rounded border border-[#1e2633] px-4 py-2 text-xs uppercase tracking-wider text-[#8b95a8] hover:text-[#e8eef5]"
              >
                {t("settings.autoWeeklyConfirmCancel")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setAutoConfirmOpen(false);
                  void autoBuy.startCycle(weekly);
                }}
                className="rounded border border-[#2dd4bf66] bg-[#0c0e12] px-4 py-2 text-xs uppercase tracking-wider text-[#2dd4bf] hover:bg-[#2dd4bf11]"
              >
                {t("settings.autoWeeklyConfirmOk")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <label className="block space-y-2 rounded-lg border border-[#1e2633] bg-[#141820] p-5">
        <span className="text-[11px] uppercase tracking-wider text-[#8b95a8]">
          {t("settings.exclusions")}
        </span>
        <input
          type="text"
          value={exclusions}
          onChange={(e) => setExclusions(e.target.value)}
          onBlur={() => writeExclusionsRaw(exclusions)}
          placeholder="xAI, OpenAI"
          className="w-full rounded border border-[#1e2633] bg-[#0c0e12] px-3 py-2 text-sm outline-none focus:border-[#a78bfa66]"
        />
      </label>

      <div className="space-y-3 rounded-lg border border-[#1e2633] bg-[#141820] p-5">
        <Toggle
          label={t("settings.buyDespiteIpo")}
          checked={buyDespiteIpo}
          onChange={setBuyDespiteIpo}
        />
        <Toggle
          label={t("settings.deadlineInvalid")}
          checked={deadlineInvalid}
          onChange={setDeadlineInvalid}
        />
        <Toggle
          label={t("settings.ipoPremium")}
          checked={ipoPremium}
          onChange={setIpoPremium}
        />
      </div>

      <section className="space-y-3 rounded-lg border border-[#2dd4bf33] bg-[#141820] p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[11px] uppercase tracking-wider text-[#2dd4bf]">
            {t("settings.byokTitle")}
          </h2>
          <span className="mono-num text-[10px] text-[#8b95a8]">
            localStorage
          </span>
        </div>
        <p className="text-xs text-[#8b95a8]">{t("settings.byokIntro")}</p>

        <label className="block space-y-1.5">
          <span className="text-[11px] text-[#c5cedb]">
            <span className="mono-num text-[#2dd4bf]">TYPESAFE_API_KEY</span>{" "}
            {t("settings.typesafeLabel")}
          </span>
          <div className="flex gap-2">
            <input
              type={showTypesafe ? "text" : "password"}
              value={typesafeKey}
              onChange={(e) => {
                setTypesafeKey(e.target.value);
                setByokSaved(false);
              }}
              placeholder="pk_…"
              autoComplete="off"
              spellCheck={false}
              className="mono-num flex-1 rounded border border-[#1e2633] bg-[#0c0e12] px-3 py-2 text-sm text-[#e8eef5] outline-none focus:border-[#2dd4bf66]"
            />
            <button
              type="button"
              onClick={() => setShowTypesafe((v) => !v)}
              className="rounded border border-[#1e2633] px-3 text-xs text-[#8b95a8] hover:text-[#e8eef5]"
            >
              {showTypesafe ? t("settings.hide") : t("settings.show")}
            </button>
          </div>
        </label>

        <label className="block space-y-1.5">
          <span className="text-[11px] text-[#c5cedb]">
            <span className="mono-num text-[#a78bfa]">XAI_API_KEY</span>{" "}
            {t("settings.xaiLabel")}
          </span>
          <div className="flex gap-2">
            <input
              type={showXai ? "text" : "password"}
              value={xaiKey}
              onChange={(e) => {
                setXaiKey(e.target.value);
                setByokSaved(false);
              }}
              placeholder="xai-…"
              autoComplete="off"
              spellCheck={false}
              className="mono-num flex-1 rounded border border-[#1e2633] bg-[#0c0e12] px-3 py-2 text-sm text-[#e8eef5] outline-none focus:border-[#a78bfa66]"
            />
            <button
              type="button"
              onClick={() => setShowXai((v) => !v)}
              className="rounded border border-[#1e2633] px-3 text-xs text-[#8b95a8] hover:text-[#e8eef5]"
            >
              {showXai ? t("settings.hide") : t("settings.show")}
            </button>
          </div>
        </label>

        <button
          type="button"
          onClick={saveByok}
          className="w-full rounded border border-[#2dd4bf44] bg-[#0c0e12] py-2 text-xs uppercase tracking-wider text-[#2dd4bf] hover:bg-[#2dd4bf11]"
        >
          {byokSaved ? t("settings.keysSaved") : t("settings.saveKeys")}
        </button>
      </section>
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between text-left font-sans text-sm font-medium tracking-normal text-[#e8eef5]"
    >
      <span className="font-sans text-sm font-medium tracking-normal">{label}</span>
      <span
          className={`relative h-6 w-11 rounded-full transition ${
            checked ? "bg-[#2dd4bf]" : "bg-[#1e2633]"
          }`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${
              checked ? "left-5" : "left-0.5"
            }`}
          />
      </span>
    </button>
  );
}
