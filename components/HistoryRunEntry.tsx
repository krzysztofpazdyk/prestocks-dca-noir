"use client";

import { mintLabel } from "@/lib/mint-label";
import {
  formatTs,
  formatUsd,
  rawToDollars,
  type RunRecordData,
} from "@/lib/predca";
import { fmtSignedPnl, fmtUsdAmount } from "@/lib/format-usd";
import { formatGrouped } from "@/lib/number-format";
import { runPnl } from "@/lib/position-value";
import { historyBudgetUsd, historyLegUsd } from "@/lib/history-view";
import type { JupQuote } from "@/lib/jup-prices";
import type { RunFillView } from "@/lib/run-fills";
import { historyRunMetaText, type RunOrigin } from "@/lib/run-origin";
import { useI18n } from "@/lib/i18n";

function runBudgetUsd(
  run: RunRecordData,
  slots: Array<{ usdc?: number } | null> | null | undefined,
  priceState: "priced" | "legacy" | "unknown",
): number | null {
  const legs = run.mints.map((_, i) =>
    historyLegUsd(priceState, slots?.[i]?.usdc, rawToDollars(run.amounts[i])),
  );
  return historyBudgetUsd(priceState, legs);
}

function fmtUnits(n: number): string {
  return formatGrouped(n, { max: 6 });
}

export function HistoryRunEntry({
  run,
  fills,
  quotes,
  origin,
}: {
  run: RunRecordData;
  fills: RunFillView[];
  quotes: Record<string, JupQuote>;
  /** null while unknown or after an RPC miss. The line then has no suffix. */
  origin: RunOrigin | null;
}) {
  const { t, locale } = useI18n();
  const fill = fills.find((row) => row.runIndex === run.runIndex.toString());
  const priceState = fill?.priceState ?? "unknown";
  const budget = runBudgetUsd(run, fill?.slots, priceState);
  const names = run.mints.map((m) => mintLabel(m, 6));
  const usdcEach = run.mints.map((_, i) =>
    historyLegUsd(
      priceState,
      fill?.slots?.[i]?.usdc,
      rawToDollars(run.amounts[i]),
    ),
  );
  const pnl =
    priceState === "unknown"
      ? null
      : runPnl(
          fill?.slots ?? null,
          usdcEach.map((n) => (n == null ? Number.NaN : n)),
          quotes,
          names,
        );
  const runPnlText =
    pnl?.totalPnlUsd != null
      ? fmtSignedPnl(pnl.totalPnlUsd, pnl.totalPnlPct, locale)
      : null;
  const runPos = pnl?.totalPnlUsd != null && pnl.totalPnlUsd > 0;
  const runNeg = pnl?.totalPnlUsd != null && pnl.totalPnlUsd < 0;
  const runClass = runPos
    ? "text-[#34d399]"
    : runNeg
      ? "text-[#f87171]"
      : "text-[#8b95a8]";

  return (
    <div>
      <div className="min-w-0 max-w-full">
        <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1 md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)] md:items-baseline">
          <p className="mono-num min-w-0 max-w-full break-words text-sm text-[#2dd4bf] md:col-start-1">
            {formatTs(run.ts)}
          </p>
          <p className="order-last min-w-0 max-w-full basis-full break-words text-center text-xs text-[#8b95a8] md:order-none md:col-start-2 md:basis-auto">
            {historyRunMetaText({
              locale,
              index: run.runIndex.toString(),
              slot: run.slot.toString(),
              budgetText: priceState === "unknown" ? null : formatUsd(budget ?? 0),
              origin,
            })}
          </p>
          {runPnlText ? (
            <p
              className={`mono-num min-w-0 max-w-full break-words text-right text-xs md:col-start-3 ${runClass}`}
            >
              {t("history.runPnl", { pnl: runPnlText })}
            </p>
          ) : (
            <span className="hidden md:col-start-3 md:block" aria-hidden="true" />
          )}
        </div>
        {priceState === "unknown" ? (
          <p className="mt-1 text-[10px] text-[#8b95a8]">{t("runPrice.loading")}</p>
        ) : null}
      </div>
      <ul className="mt-3 grid gap-1 sm:grid-cols-3">
        {run.mints.map((m, i) => {
          const slot = fill?.slots?.[i] ?? null;
          const leg = pnl?.legs[i] ?? null;
          return (
            <li
              key={`${run.runIndex.toString()}-${i}`}
              className="rounded border border-[#1e2633] bg-[#0c0e12] px-2 py-1.5 text-xs"
            >
              <span className="text-[#c5cedb]">{mintLabel(m, 6)}</span>
              <span className="mono-num ml-2 text-[#8b95a8]">
                {usdcEach[i] == null
                  ? t("runPrice.unknown")
                  : formatUsd(usdcEach[i])}
              </span>
              {slot ? (
                <span className="mono-num mt-0.5 block text-[10px] text-[#8b95a8]">
                  {t("history.buyPrice", {
                    price: fmtUsdAmount(slot.price, locale) ?? t("positions.noData"),
                    units: fmtUnits(slot.units),
                  })}
                  {leg ? (
                    <span className="mt-0.5 block">
                      {t("history.legPnl", {
                        value:
                          fmtUsdAmount(leg.valueUsd, locale) ??
                          t("positions.noData"),
                        pnl:
                          fmtSignedPnl(leg.pnlUsd, leg.pnlPct, locale) ??
                          t("positions.noData"),
                      })}
                    </span>
                  ) : null}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
