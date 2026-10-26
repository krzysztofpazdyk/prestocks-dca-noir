import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  adapterAutoConnectFor,
  parseStoredWalletName,
  readStoredWalletName,
  shouldRestorePrivySession,
  WALLET_NAME_STORAGE_KEY,
} from "../lib/connect-wallet";

test("wallet-adapter stores the name as JSON", () => {
  assert.equal(parseStoredWalletName(null), null);
  assert.equal(parseStoredWalletName(""), null);
  assert.equal(parseStoredWalletName(JSON.stringify("Phantom")), "Phantom");
  assert.equal(parseStoredWalletName(JSON.stringify("Privy")), "Privy");
  assert.equal(parseStoredWalletName("Solflare"), "Solflare");
  const storage = new Map<string, string>();
  storage.set(WALLET_NAME_STORAGE_KEY, JSON.stringify("Phantom"));
  assert.equal(
    readStoredWalletName({
      getItem: (key) => storage.get(key) ?? null,
    }),
    "Phantom",
  );
});

test("only Phantom and Solflare use adapter autoConnect", () => {
  assert.equal(adapterAutoConnectFor("Phantom"), true);
  assert.equal(adapterAutoConnectFor("Solflare"), true);
  assert.equal(adapterAutoConnectFor("Privy"), false);
  assert.equal(adapterAutoConnectFor(null), false);
  assert.equal(adapterAutoConnectFor(""), false);
});

test("Privy session restores only for the last Privy wallet", () => {
  const ready = {
    storedName: "Privy",
    ready: true,
    authenticated: true,
    hasEmbeddedWallet: true,
  };
  assert.equal(shouldRestorePrivySession(ready), true);
  assert.equal(shouldRestorePrivySession({ ...ready, storedName: "Phantom" }), false);
  assert.equal(shouldRestorePrivySession({ ...ready, storedName: null }), false);
  assert.equal(shouldRestorePrivySession({ ...ready, authenticated: false }), false);
  assert.equal(shouldRestorePrivySession({ ...ready, ready: false }), false);
  assert.equal(shouldRestorePrivySession({ ...ready, hasEmbeddedWallet: false }), false);
});

test("reload wires Phantom autoConnect, Privy restore, and the connect prompt", () => {
  const provider = readFileSync(
    new URL("../components/SolanaWalletProvider.tsx", import.meta.url),
    "utf8",
  );
  assert.match(provider, /adapterAutoConnectFor\(readStoredWalletName\(localStorage\)\)/);
  assert.match(provider, /autoConnect=\{autoConnect\}/);
  assert.doesNotMatch(provider, /autoConnect=\{false\}/);

  const button = readFileSync(
    new URL("../components/ConnectWalletButton.tsx", import.meta.url),
    "utf8",
  );
  assert.match(button, /shouldRestorePrivySession/);
  assert.match(button, /requestRef\.current\(PRIVY_WALLET_NAME\)/);

  const overview = readFileSync(
    new URL("../components/OverviewView.tsx", import.meta.url),
    "utf8",
  );
  assert.match(overview, /t\("lastPurchase\.emptyDisconnected"\)/);
  assert.match(overview, /t\("connect\.busy"\)/);

  const history = readFileSync(
    new URL("../components/HistoryView.tsx", import.meta.url),
    "utf8",
  );
  assert.match(history, /t\("connect\.title"\)/);
  assert.match(history, /connecting \? t\("connect\.busy"\) : t\("connect\.title"\)/);
});
