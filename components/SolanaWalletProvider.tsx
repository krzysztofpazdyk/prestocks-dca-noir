"use client";

import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { Adapter } from "@solana/wallet-adapter-base";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { rpcUrl } from "@/lib/predca";
import { PredcaProvider } from "@/lib/hooks/usePredca";
import { privyAppId } from "@/lib/privy-devnet";
import { PrivyWalletBridge } from "@/components/PrivyWalletBridge";
import {
  RUNTIME_CONFIG_TIMEOUT_MS,
  loadRuntimeConfig,
  runtimeConfigReady,
  runtimeConfigServerReady,
  settleRuntimeConfig,
  subscribeRuntimeConfig,
} from "@/lib/runtime-config";

function useRuntimeConfigReady(): boolean {
  const ready = useSyncExternalStore(
    subscribeRuntimeConfig,
    runtimeConfigReady,
    runtimeConfigServerReady,
  );
  useEffect(() => {
    // Fetch limit is 5s and is registered first. This backstop only fires if
    // that promise fails to settle, so a fast config does not flash a label.
    const safety = setTimeout(settleRuntimeConfig, RUNTIME_CONFIG_TIMEOUT_MS + 200);
    void loadRuntimeConfig().finally(() => {
      clearTimeout(safety);
    });
    return () => {
      clearTimeout(safety);
    };
  }, []);
  return ready;
}

export function SolanaWalletProvider({ children }: { children: ReactNode }) {
  const configReady = useRuntimeConfigReady();
  const endpoint = useMemo(() => rpcUrl(), []);
  const privyOn = privyAppId().length > 0;
  // Privy is registered only via Wallet Standard (PrivyWalletBridge). A second
  // PrivyEmbeddedWalletAdapter here shows up twice and triggers Privy's
  // "Wallet Adapter for Privy can be removed" warning.
  const wallets = useMemo<Adapter[]>(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    [],
  );
  const config = useMemo(() => ({ commitment: "confirmed" as const }), []);

  const tree = <PredcaProvider>{children}</PredcaProvider>;

  if (!configReady) return null;

  return (
    <ConnectionProvider endpoint={endpoint} config={config}>
      <WalletProvider wallets={wallets} autoConnect={false}>
        <WalletModalProvider>
          {privyOn ? <PrivyWalletBridge>{tree}</PrivyWalletBridge> : tree}
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
