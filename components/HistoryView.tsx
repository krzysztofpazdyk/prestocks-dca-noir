"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { usePredca } from "@/lib/hooks/usePredca";
import { TxNotice } from "@/components/TxNotice";
import { HistoryRunEntry } from "@/components/HistoryRunEntry";
import { historyView } from "@/lib/history-view";
import { runsNewestFirst } from "@/lib/run-order";
import { useI18n } from "@/lib/i18n";

export function HistoryView() {
  const { connected, connecting } = useWallet();
  const predca = usePredca();
  const { t } = useI18n();
  const mode = historyView(predca.status, predca.runs.length, connected);
  const showRuns = mode === "list" || mode === "list_stale";
  const disconnectedCopy = connecting ? t("connect.busy") : t("connect.title");

  let intro: string;
  if (mode === "disconnected") {
    intro = disconnectedCopy;
  } else if (mode === "loading") {
    intro = t("history.loading");
  } else if (showRuns) {
    intro = t("history.onChainIntro", {
      count: predca.runs.length,
    });
  } else if (mode === "empty") {
    intro = t("history.noRuns");
  } else if (mode === "not_ready") {
    intro = t("history.notReady");
  } else {
    intro = t("history.fetchError");
  }

  return (
    <div className="space-y-5">
      <div>
        <p className="text-[10px] uppercase tracking-[0.2em] text-[#a78bfa]">
          {t("history.kicker")}
        </p>
        <h1 className="mt-1 text-xl font-semibold">{t("history.title")}</h1>
        <p className="mt-1 text-xs text-[#8b95a8]">{intro}</p>
      </div>

      {predca.status === "error" && predca.rpcError ? (
        <TxNotice message={predca.rpcError} tone="error" />
      ) : null}

      {mode === "disconnected" && (
        <p className="rounded border border-dashed border-[#1e2633] px-3 py-6 text-center text-xs text-[#8b95a8]">
          {disconnectedCopy}
        </p>
      )}

      {mode === "loading" && (
        <p className="rounded border border-dashed border-[#1e2633] px-3 py-6 text-center text-xs text-[#8b95a8]">
          {t("history.loading")}
        </p>
      )}

      {(mode === "error" || mode === "not_ready") && (
        <p className="rounded border border-dashed border-[#1e2633] px-3 py-6 text-center text-xs text-[#8b95a8]">
          {mode === "error" ? t("history.fetchError") : t("history.notReady")}
        </p>
      )}

      {mode === "empty" && (
        <p className="rounded border border-dashed border-[#1e2633] px-3 py-6 text-center text-xs text-[#8b95a8]">
          {t("history.noRuns")}
        </p>
      )}

      {mode === "list_stale" && (
        <p className="text-xs text-[#fbbf24]">{t("history.staleRuns")}</p>
      )}

      {showRuns && (
        <ul className="space-y-3">
          {runsNewestFirst(predca.runs).map((run) => (
            <li
              key={run.runIndex.toString()}
              className="rounded-lg border border-[#1e2633] bg-[#141820] p-4"
            >
              <HistoryRunEntry
                run={run}
                fills={predca.runFills}
                quotes={predca.jupPrices.quotes}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
