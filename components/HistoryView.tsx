"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { PublicKey } from "@solana/web3.js";
import { usePredca } from "@/lib/hooks/usePredca";
import { TxNotice } from "@/components/TxNotice";
import { HistoryRunEntry } from "@/components/HistoryRunEntry";
import { historyEntriesLine, historyView } from "@/lib/history-view";
import { runsNewestFirst } from "@/lib/run-order";
import {
  loadRunOrigin,
  originsFromSnapshot,
  readRunOriginSnapshot,
  runOriginStorage,
  subscribeRunOriginCache,
  writeRunOriginCache,
  type RunOrigin,
} from "@/lib/run-origin";
import { useI18n } from "@/lib/i18n";

const originFlights = new Set<string>();

function useRunOrigins(
  owner: PublicKey | null,
  runIndexKey: string,
): Record<string, RunOrigin> {
  const { connection } = useConnection();
  const ownerBase58 = owner?.toBase58() ?? null;
  const snapshot = useSyncExternalStore(
    subscribeRunOriginCache,
    () => readRunOriginSnapshot(ownerBase58, runIndexKey),
    () => "",
  );

  useEffect(() => {
    if (!owner || !ownerBase58) return;
    const known = new Set(Object.keys(originsFromSnapshot(snapshot)));
    const missing = runIndexKey
      .split(",")
      .filter((index) => index.length > 0 && !known.has(index));
    if (missing.length === 0) return;

    void Promise.all(
      missing.map(async (index) => {
        const flight = `${ownerBase58}.${index}`;
        if (originFlights.has(flight)) return;
        originFlights.add(flight);
        try {
          const result = await loadRunOrigin(connection, owner, index);
          if (!result.ok || !result.origin) return;
          const store = runOriginStorage();
          if (store) writeRunOriginCache(store, ownerBase58, index, result.origin);
        } finally {
          originFlights.delete(flight);
        }
      }),
    );
  }, [connection, owner, ownerBase58, runIndexKey, snapshot]);

  return originsFromSnapshot(snapshot);
}

export function HistoryView() {
  const { connected, connecting } = useWallet();
  const predca = usePredca();
  const { locale, t } = useI18n();
  const mode = historyView(predca.status, predca.runs.length, connected);
  const showRuns = mode === "list" || mode === "list_stale";
  const runIndexKey = predca.runs.map((run) => run.runIndex.toString()).join(",");
  const origins = useRunOrigins(predca.owner, runIndexKey);
  const disconnectedCopy = connecting ? t("connect.busy") : t("connect.title");

  let intro: string;
  if (mode === "disconnected") {
    intro = disconnectedCopy;
  } else if (mode === "loading") {
    intro = t("history.loading");
  } else if (showRuns) {
    intro = historyEntriesLine(predca.runs.length, locale);
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
        {showRuns ? (
          <h1 className="text-xs uppercase tracking-[0.2em] text-[#a78bfa]">
            {intro}
          </h1>
        ) : (
          <p className="text-xs text-[#8b95a8]">{intro}</p>
        )}
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
                origin={origins[run.runIndex.toString()] ?? null}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
