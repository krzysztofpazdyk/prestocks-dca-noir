"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  getLocaleServerSnapshot,
  getLocaleSnapshot,
  subscribeLocale,
  writeStoredLocale,
  type Locale,
} from "@/lib/locale-store";
import {
  NUMBER_LOCALE_FALLBACK,
  formatGrouped,
  readBrowserNumberLocale,
  subscribeNumberLocale,
  syncNumberLocale,
} from "@/lib/number-format";

export type { Locale };
export { DEFAULT_LOCALE, LOCALE_STORAGE_KEY };

type Dict = Record<string, string>;

const pl: Dict = {
  "nav.brand": "noir 3.0",
  "nav.overview": "Overview",
  "nav.settings": "Ustawienia",
  "nav.history": "Historia",
  "nav.selectWallet": "Zaloguj",
  "connect.title": "Połącz portfel",
  "connect.close": "Zamknij",
  "connect.privy": "Privy",
  "connect.privyHint": "E-mail / Google · osobny adres",
  "connect.disconnect": "Rozłącz",
  "connect.change": "Zmień portfel",
  "connect.busy": "Łączenie…",
  "connect.detected": "Wykryty",
  "connect.notDetected": "Nie wykryto",
  "connect.notReady": "Ten portfel nie jest wykryty w tej przeglądarce.",
  "connect.failed": "Nie udało się połączyć.",
  "connect.timeout": "Połączenie trwało zbyt długo. Spróbuj ponownie.",
  "privy.login": "Zaloguj e-mail / Google (Privy)",
  "privy.connect": "Połącz portfel Privy",
  "privy.connected": "Privy {address}",
  "privy.busy": "Privy…",
  "privy.signWait":
    "Zatwierdź i zamknij okno Privy, żeby wysłać transakcję",
  "privy.signSuccessHeader": "Podpisano. Kliknij Close, aby wysłać.",
  "privy.signSuccessDescription":
    "To jeszcze nie jest wysłanie. Środki nie zostały ruszone.",
  "privy.blockhashExpired":
    "Transakcja nie została wysłana. Środki nie zostały ruszone. Spróbuj ponownie i szybciej zamknij okno Privy.",

  "overview.kicker": "Trading desk · PreStocks Weekly DCA",
  "overview.title": "Overview",
  "overview.maxDepositHint": "Maks. wpłata: {amount} (saldo portfela)",
  "overview.maxWithdrawHint": "Maks. wypłata: {amount} (saldo vaulta)",
  "overview.disconnectedHint":
    "Portfel odłączony — podłącz wallet, by zobaczyć salda on-chain. {cluster}.",
  "overview.noMintHint":
    "Ustaw NEXT_PUBLIC_USDC_MINT na lokalny mock mint.",
  "overview.onChainHint": "On-chain · {cluster} · wartości z RPC",
  "overview.rpcStale": "ostatni odczyt",
  "overview.clusterMainnet":
    "Uwaga: RPC wygląda na Mainnet — ta aplikacja jest Devnet-only. Sprawdź NEXT_PUBLIC_RPC_URL.",
  "overview.clusterNotDevnet":
    "Uwaga: oczekiwano Devnet, genesis RPC = {genesis}. Sprawdź sieć / RPC.",

  "faucet.button": "Weź 1000 USDC + 0.1 SOL (demo)",
  "faucet.busy": "Wysyłam USDC + SOL…",
  "faucet.success": "Wysłano 1000 USDC + 0.1 SOL do portfela (demo) · sig {sig}.",
  "faucet.nextSteps": "Następnie: Wpłać do vaulta (≥ budżet tygodniowy) + Wygeneruj rekomendacje — wtedy Dokonaj zakupu się odblokuje.",
  "faucet.error": "Faucet: {error}",
  "faucet.needWallet": "Podłącz portfel, by wziąć demo USDC + SOL.",

  "predca.title": "Predca on-chain ({cluster})",
  "predca.rpc": "RPC:",
  "predca.refresh": "Odśwież",
  "predca.loading": "Ładowanie…",
  "predca.budget": "Budżet tygodniowy",
  "predca.vault": "Vault",
  "predca.depositTitle": "Wpłata",
  "predca.withdrawTitle": "Wypłata",
  "predca.deposit": "Wpłać",
  "predca.withdraw": "Wypłać",
  "predca.rpcActionHint": "Nieaktywne — brak połączenia z RPC Devnet. Kliknij Odśwież.",
  "predca.hintNoAta":
    "Wskazówka: brak ATA mock USDC — Wpłata zwykle się nie uda, dopóki nie masz konta tokenowego dla mint {mint} na Devnet.",
  "predca.hintZeroUsdc":
    "Wskazówka: saldo mock USDC = 0 — doładuj ATA (mint {mint}) przed wpłatą.",
  "predca.mintLabel": "Mint mock USDC:",
  "predca.mintNoAta":
    "· Brak ATA / saldo — utwórz konto tokenowe i zrób mint testowych USDC na Devnet przed wpłatą.",
  "predca.initBudget": "Budżet tygodniowy (USDC)",
  "predca.initialize": "Initialize",
  "predca.waiting": "Czekam…",
  "predca.initHint":
    "Pierwsza wpłata = initialize_user + deposit w jednej tx. Budżet tygodniowy bierze się z Ustawień (ta sama kwota). Zmień go w Ustawieniach, potem wpłać USDC z ATA portfela.",
  "predca.rentHint":
    "Hint: init tworzy UserConfig + vault ATA — potrzebujesz ~0.002–0.003 SOL na rent (opłata konta).",
  "predca.depositUnavailable":
    "Wpłata niedostępna ({reason}). Podłącz portfel z mintem USDC, by wpłacić.",
  "predca.status.loading": "ładowanie…",
  "predca.status.no_mint": "brak mint",
  "predca.status.disconnected": "brak portfela",
  "predca.status.error": "błąd",
  "predca.lastRun": "Ostatni RunRecord on-chain",
  "predca.runMintAddress": "Adres mintu: {mint}",

  "tile.sol": "SOL",
  "tile.usdcWallet": "USDC (portfel)",
  "tile.portfolioPreStock": "Wartość portfela PreStock",
  "tile.portfolioHint":
    "Wartość portfela PreStock: vault USDC + wartość tokenów (zakupy v2 po cenie rynkowej; starsze 1:1 po koszcie). USDC w portfelu osobno.",

  "holdings.titleOnChain": "Alokacja holdings (on-chain ATAs)",
  "holdings.titleOffline": "Alokacja holdings (offline)",
  "holdings.titleDisconnected": "Alokacja holdings",
  "holdings.emptyConnected":
    "Brak niezerowych sald mock PreStock w ATA — wykonaj zakup (simulate_buy_v2) lub czekaj na mint.",
  "holdings.empty": "Brak holdings.",
  "holdings.emptyDisconnected": "Podłącz portfel, by zobaczyć holdings on-chain.",
  "holdings.allocation": "alokacja",
  "holdings.share": "udział",

  "top3.title": "Top-3 · rekomendacje",
  "top3.titleLive": "Top-3 · ranking (live)",
  "top3.restored": "z {time}",
  "btn.generate": "Wygeneruj rekomendacje",
  "btn.generating": "Generuję…",
  "btn.purchase": "Dokonaj zakupu",
  "btn.confirm": "Potwierdź",
  "btn.cancel": "Anuluj",
  "btn.buying": "Kupuję…",
  "btn.waiting": "Czekam na potwierdzenie…",
  "btn.txPending": "Transakcja…",
  "empty.generateTips": "Kliknij Wygeneruj rekomendacje.",
  "empty.connectWallet": "Podłącz portfel, potem wygeneruj rekomendacje.",

  "lastPurchase.titleOnChain": "Ostatni zakup (on-chain)",
  "lastPurchase.titleConnected": "Ostatni zakup",
  "lastPurchase.titleOffline": "Ostatni zakup (offline)",
  "lastPurchase.titleDisconnected": "Ostatni zakup",
  "lastPurchase.emptyConnected":
    "Brak RunRecord — wykonaj pierwszy zakup (simulate_buy_v2).",
  "lastPurchase.empty": "Brak zapisanych zakupów.",
  "lastPurchase.emptyDisconnected": "Podłącz portfel, by zobaczyć zakupy on-chain.",
  "lastPurchase.date": "Data:",
  "lastPurchase.budget": "Budżet:",
  "lastPurchase.perToken":
    "· po równo na 3 spółki (~${amount} na każdą, liczba akcji zależy od ceny)",
  "lastPurchase.bought": "Kupione:",

  "msg.noTop3Proxy": "Proxy /rank nie zwróciło top3.",
  "msg.noTypesafeKey": "Brak TYPESAFE_API_KEY w Ustawieniach",
  "msg.tooFewProducts": "Za mało produktów PreStocks do rankingu (<3).",
  "purchase.disabled.tx": "Transakcja w toku…",
  "purchase.disabled.noRecs": "Zakup nieaktywny — najpierw kliknij Wygeneruj rekomendacje (top-3).",
  "purchase.disabled.notReady": "Zakup nieaktywny — najpierw wpłać USDC na Overview (konto powstaje z wpłatą).",
  "purchase.disabled.rpcError": "Zakup nieaktywny — brak połączenia z RPC Devnet. Kliknij Odśwież.",
  "purchase.disabled.flatRanking": "Zakup nieaktywny — ranking awaryjny nie rozróżnia spółek (wszystkie 50,0). Spróbuj ponownie później albo włącz „Premia IPO ma znaczenie”.",
  "purchase.confirmBudget": "Zmienię budżet on-chain z {from} na {to} i kupię. Potwierdzić?",
  "purchase.disabled.vaultLow": "Zakup nieaktywny — vault ma {have}, potrzeba ≥ {need}. Wpłać z portfela (faucet zasila portfel, nie vault).",
  "purchase.disabled.generic": "Zakup nieaktywny — sprawdź vault, ranking i status Predca.",
  "tx.recheck": "Sprawdź ponownie",
  "tx.rechecking": "Sprawdzam…",
  "dup.warn": "Poprzednia {action} ({amount}) jest jeszcze niepotwierdzona i może wejść. Wysłać drugą?",
  "dup.sendAnyway": "Wyślij mimo to",
  "dup.action.deposit": "wpłata",
  "dup.action.withdraw": "wypłata",
  "dup.action.buy": "zakup",
  "dup.prevConfirmed": "Poprzednia {action} weszła. Kliknij ponownie, aby wysłać nową.",
  "msg.noRecs": "Brak rekomendacji do zakupu.",
  "msg.vaultLowOnChain":
    "Za mało USDC w vault (on-chain): {have} < {need}.",
  "msg.purchaseOk":
    "Zakup on-chain OK · sig {sig}… · ${amount} z vault → {tokens}",
  "buy.preview": "≈ {legs}",
  "buy.previewLeg": "{tokens} {name} po {price}",
  "buy.stepAta": "Krok 1/2: tworzę konta tokenów (podpis)",
  "buy.stepBuy": "Krok 2/2: zakup (podpis)",
  "buy.ataCreatedNoVault":
    "Konta tokenów zostały utworzone, ale zakup nie przeszedł. Środki z vaulta nie zostały ruszone.",
  "buy.ataUnconfirmedNoBuy":
    "Konta tokenów nie zostały potwierdzone. Zakup nie został wysłany. Środki z vaulta nie zostały ruszone.",
  "tx.ok.initDeposit": "Zainicjalizowano Predca + wpłacono ${amount} do vault.",
  "tx.ok.deposit": "Wpłacono ${amount} do vault.",
  "tx.ok.withdraw": "Wypłacono ${amount} z vault.",
  "tx.ok.budget": "Zapisano budżet tygodniowy on-chain.",
  "tx.ok.buyConfirmed": "Zakup on-chain potwierdzony: ${amount} z vault.",
  "tx.ok.buyConfirmedShort": "Zakup on-chain potwierdzony.",
  "tx.ok.simulateBuy":
    "Zakup on-chain (simulate_buy_v2): ${amount} z vault → ⅓ na {names}.{preview}",
  "tx.buyPreviewLeg": "≈ {tokens} {name} po ${price}",
  "tx.err.noBuyIx": "Brak instrukcji zakupu.",
  "tx.err.rejected": "Transakcja odrzucona przez Devnet. {signature}",
  "tx.err.rejectedShort": "Transakcja odrzucona przez Devnet.",
  "msg.purchaseFail":
    "Zakup nieudany — szczegóły w sekcji Predca powyżej (czerwony komunikat).",
  "msg.purchasePending":
    "Zakup wysłany, Devnet jeszcze nie potwierdził · {sig} {url}. Nie wysyłaj drugi raz.",
  "msg.updatingBudget": "Aktualizuję budżet on-chain…",
  "msg.budgetSyncFail":
    "Nie udało się zaktualizować budżetu on-chain przed zakupem.",
  "msg.predcaNotReady":
    "Predca nie jest gotowe — wpłać USDC na Overview (konto powstaje z wpłatą), potem zakup on-chain.",
  "msg.vaultLowMock":
    "Za mało USDC w vault (mock): {have} < {need}.",
  "msg.purchaseOffline":
    "Zakup zapisany (offline mock): ${amount} z vault → ⅓ na {tokens}",
  "msg.connectForPurchase":
    "Podłącz portfel i wpłać USDC na Overview, by kupować on-chain.",
  "msg.purchaseError": "Nie udało się wykonać zakupu.",
  "msg.autoNoRecs": "Auto-zakup: ranking nie zwrócił top-3.",

  "auto.status.off": "Auto-zakup wyłączony — włącz w Ustawieniach.",
  "auto.status.next": "Następny automatyczny zakup z vaulta: {when}",
  "auto.status.due":
    "Auto-zakup zaległy — ranking i zakup z vaulta odpalą się same.",
  "auto.status.ranking": "Auto-zakup: generuję ranking (Grok→Jev)…",
  "auto.status.buying":
    "Auto-zakup: pierwszy zakup — podpisz transakcję w portfelu.",
  "auto.status.buyingKeeper":
    "Auto-zakup: keeper kupuje z vaulta (bez podpisu portfela).",
  "auto.status.keeperDown":
    "Keeper niedostępny (tunel lub usługa). UI nie kupuje sam — spróbuj później lub sprawdź połączenie.",
  "auto.status.ok":
    "Automatyczny zakup tygodniowy OK · ${amount} z vault → {tokens}",
  "auto.status.okWithNext":
    "Automatyczny zakup tygodniowy OK · ${amount} z vault → {tokens} · następny zakup: {nextBuy}",
  "auto.status.vaultLow":
    "Auto-zakup wstrzymany — za mało USDC w vault ({have} < {need}).",
  "auto.status.needWallet":
    "Podłącz portfel, żeby włączyć keepersa (wystarczy pubkey — zakup zrobi bot).",
  "auto.status.notReady":
    "Najpierw wpłać USDC na Overview — konto Predca powstaje razem z pierwszą wpłatą.",
  "auto.status.stillLoading":
    "Predca jeszcze się ładuje — spróbuj włączyć auto-zakup za chwilę.",
  "auto.status.needVault":
    "Najpierw wpłać USDC do vaulta na Overview. Auto-zakup startuje, gdy vault ma środki.",
  "auto.status.error": "Auto-zakup nieudany: {reason}",
  "auto.error.fallback": "Auto-zakup nieudany. Spróbuj ponownie później.",
  "auto.error.insufficient": "Za mało środków na auto-zakup.",
  "auto.error.rejected": "Odrzucono prośbę w portfelu.",
  "auto.error.slippage": "Cena się zmieniła. Spróbuj ponownie później.",
  "auto.error.network": "Problem z siecią. Spróbuj ponownie później.",
  "auto.error.simulation": "Symulacja transakcji nie powiodła się.",
  "auto.error.predca.6000": "Brak uprawnień (Unauthorized).",
  "auto.error.predca.6001": "Kwota musi być większa od zera.",
  "auto.error.predca.6002": "Niewystarczające saldo w vault.",
  "auto.error.predca.6003": "Nieprawidłowy budżet tygodniowy (musi być > 0).",
  "auto.error.predca.6004": "Indeks RunRecord zajęty. Spróbuj ponownie.",
  "auto.error.predca.6005": "Mint authority musi być PDA mint_auth programu.",
  "auto.error.predca.6006": "Mint nie zgadza się z kontem w instrukcji.",
  "auto.error.predca.6007": "Duplikaty mintów w top-3.",
  "auto.error.predca.6008": "Za wcześnie: odczekaj 7 dni od ostatniego zakupu (TooSoon).",
  "auto.error.predca.6009": "Brak ceny dla tokena — keeper jeszcze jej nie ustawił.",
  "auto.error.predca.6010":
    "Cena tokena jest nieaktualna. Keeper odświeża ceny co kilka minut — spróbuj za chwilę.",
  "auto.error.predca.6011": "Nieprawidłowa cena tokena.",
  "auto.error.predca.6012": "Nieprawidłowe parametry ceny.",
  "auto.error.predca.6013": "Zmiana ceny jest zbyt duża.",
  "auto.error.predca.6014": "Przepełnienie obliczeń ceny.",
  "auto.error.predca.6015":
    "Kwota tokena zaokrągliła się do zera — cena jest zbyt wysoka względem budżetu.",
  "auto.status.enablePending":
    "Keeper jeszcze kończy włączanie. Zaczekaj — nie wysyłaj drugiego włączenia.",
  "auto.status.enableUnknown":
    "Nie wiadomo, czy keeper skończył włączanie. Sprawdź status auto-zakupu.",
  "auto.status.backoff":
    "Auto-zakup: ponowna próba za chwilę (ostatnia nieudana).",
  "auto.banner.ranking": "Cotygodniowy zakup z vaulta: ranking…",
  "auto.banner.buying":
    "Cotygodniowy zakup z vaulta: keeper (bez podpisu w karcie).",
  "auto.banner.confirming":
    "Cotygodniowy zakup z vaulta: czekam na potwierdzenie transakcji.",

  "settings.kicker": "Konfiguracja DCA",
  "settings.title": "Ustawienia",
  "settings.intro":
    "Tygodniowa kwota zapisuje się lokalnie od razu (bez portfela — do pierwszego połączenia). Konto on-chain powstaje przy pierwszej wpłacie na Overview. Potem budżet zmienia „Zapisz budżet on-chain”, Manual Buy albo włączenie auto-zakupu. BYOK zostaje w localStorage.",
  "settings.weeklyAmount": "Tygodniowa kwota (USDC)",
  "settings.weeklyInvalid": "Podaj kwotę ≥ 1 USDC, max 2 miejsca po przecinku.",
  "settings.weeklyAtEnable":
    "Zapis lokalny od razu (bez portfela — do pierwszego połączenia). Bez konta Predca kwota on-chain powstaje przy wpłacie na Overview.",
  "settings.budgetNeedsDeposit":
    "Budżet lokalny jest zapisany. Kwota on-chain pojawi się po wpłacie USDC na Overview.",
  "settings.autoWeekly": "Automatyczny cotygodniowy zakup z vaulta",
  "settings.autoWeeklyHint":
    "Domyślnie wyłączone. Włączenie bierze kwotę z pola powyżej i od razu kupuje 3 PreStock. Ta transakcja uruchamia cotygodniowy harmonogram. Późniejszych zakupów nie musisz już potwierdzać.",
  "settings.autoWeeklyConfirmTitle": "Włączyć cotygodniowy zakup z vaulta?",
  "settings.autoWeeklyConfirmBody":
    "Kontynuacja podzieli ${amount} z vaulta po równo na 3 spółki PreStock. Dostaniesz różną liczbę akcji, zależnie od ceny każdej. Ta transakcja uruchamia cotygodniowy harmonogram. Późniejszych zakupów nie musisz już potwierdzać.",
  "settings.autoWeeklyConfirmOk": "Kontynuuj",
  "settings.autoWeeklyConfirmCancel": "Anuluj",
  "settings.keeperModeLive": "Tryb: Live (prawdziwe zakupy)",
  "settings.keeperModeDryRun": "Tryb: Dry-run (bez transakcji)",
  "settings.keeperModeUnknown": "Tryb keepersa: nieznany",
  "settings.weeklySplit":
    "Po równo na 3 spółki z top-3 (~${amount} na każdą; liczba akcji zależy od ceny)",
  "settings.onChainBudget": "· on-chain:",
  "settings.saveLocal": "Zapisz lokalnie",
  "settings.savedLocal": "Zapisano lokalnie (brak portfela)",
  "settings.noMint": "Brak NEXT_PUBLIC_USDC_MINT",
  "settings.saveOnChain": "Zapisz budżet on-chain",
  "settings.savingOnChain": "Zapis on-chain…",
  "settings.connectForBudget":
    "Podłącz portfel. Budżet lokalny zapisuje się od razu; on-chain dopiero po wpłacie na Overview.",
  "settings.saved": "· zapisano ✓",
  "settings.cleared": "· wyczyszczono ✓",
  "settings.exclusions": "Wykluczenia (np. OpenAI, Kalshi) — stosowane w rankingu",
  "settings.fixedExclusion": "xAI — zawsze wykluczony (niedostępny w PreStocks DCA)",
  "settings.buyDespiteIpo": "Kup PreStock mimo odbytego IPO",
  "settings.deadlineInvalid": "Dopuszczaj tokeny po terminie ważności lub z nieważnym terminem (po dacie końcowej są bezwartościowe).",
  "settings.ipoPremium": "Premia IPO ma znaczenie (uwzględniaj różnicę wyceny tokenu względem rynku, np. −20% / +34%).",
  "settings.noData": "brak danych",
  "settings.noDataTooltip": "PreStocks API nie podaje jeszcze tych danych — przełącznik nic nie zmienia.",
  "settings.dataKnown": "Dane: {list}",
  "settings.dataUnknown": "Brak danych: {names} — te spółki nie są filtrowane.",
  "settings.dataStale": "Nieaktualne (> 7 dni): {names}.",
  "settings.ipoListed": "notowana {date}",
  "settings.ipoAnnounced": "IPO planowane {date}",
  "settings.deadlineOn": "termin {date}",
  "settings.checkedOn": "sprawdzono {date}",
  "settings.prefsDirtyHint":
    "Zmieniono ustawienia. Aby zapisać je u keepersa, trzeba podpisać wiadomość w portfelu.",
  "settings.prefsSignSave": "Podpisz i zapisz",
  "settings.prefsSignSaving": "Podpisywanie…",
  "settings.prefsConnectWallet": "Podłącz portfel, aby podpisać i zapisać",
  "settings.prefsSignNeedWallet": "Podłącz portfel z signMessage, aby zapisać",
  "settings.prefsSignFailed": "Nie udało się zapisać (podpis lub keeper).",
  "settings.prefsSignOk": "Zapisano u keepersa ✓",
  "settings.prefsLoading": "Wczytywanie ustawień keepera…",
  "settings.byokTitle": "BYOK — własne klucze API (Bring Your Own)",
  "settings.byokIntro":
    "Klucz demo Jev jest wpisany. Wklej własny, żeby go zastąpić.",
  "settings.byokIntroEmpty": "Wklej klucz TypeSafe (Jev).",
  "settings.typesafeLabel":
    "(Jev) — klucz demo jest wpisany; wklej własny, żeby go zastąpić",
  "settings.typesafeLabelEmpty": "(Jev) — wklej klucz TypeSafe",
  "settings.xaiLabel":
    "/ Grok — opcjonalny klucz klienta do analizy Grok (wysyłany do API rankingu); pusty = Jev/metryki bez Grok. Jev bierze klucz TypeSafe z pola powyżej.",
  "settings.show": "Pokaż",
  "settings.hide": "Ukryj",
  "settings.saveKeys": "Zapisz klucze w localStorage",
  "settings.keysSaved": "Zapisano w localStorage ✓",

  "history.kicker": "Przebiegi DCA",
  "history.title": "Historia",
  "history.onChainIntro":
    "RunRecord on-chain · {count} wpis(ów) ({cluster}).",
  "history.connectHint":
    "Podłącz portfel, aby zobaczyć historię zakupów (RunRecord) z Predca.",
  "history.noRuns":
    "Brak RunRecord on-chain — wykonaj pierwszy zakup (simulate_buy_v2) lub poczekaj na record_run.",
  "history.notReady":
    "Predca nie jest gotowe — wpłać USDC na Overview, potem pojawią się przebiegi.",
  "history.fetchError": "Nie udało się pobrać historii",
  "history.staleRuns": "Ostatni odczyt — RPC niedostępne, dane mogą być nieaktualne.",
  "history.loading": "Ładowanie historii on-chain…",
  "history.runMeta": "Run #{index} · budżet ~{budget} · slot {slot}",
  "history.runMetaUnknown": "Run #{index} · budżet {unknown} · slot {slot}",
  "history.buyPrice": "po {price} · {units} szt.",
  "history.legPnl": "teraz {value} · {pnl}",
  "history.runPnl": "PnL: {pnl}",

  "positions.title": "Pozycje",
  "positions.col.asset": "Aktywo",
  "positions.col.units": "Jednostki",
  "positions.col.price": "Cena teraz",
  "positions.col.value": "Wartość",
  "positions.col.avgBuy": "Śr. cena zakupu",
  "positions.col.pnl": "Zysk/strata",
  "positions.noData": "brak danych",
  "positions.atCost": "po koszcie (zakup 1:1 sprzed v2)",
  "positions.legacyHint":
    "Wcześniejsze zakupy na Devnecie mintowały tokeny 1:1 do USDC — wyceniamy je po koszcie.",
  "positions.mismatch": "Saldo tokenów różni się od historii zakupów.",
  "runPrice.loading": "dane o cenie zakupu się ładują",
  "runPrice.unknown": "—",
  "balances.warning":
    "Salda tokenów chwilowo niedostępne — pokazuję poprzednie. Odśwież za chwilę.",
  "portfolio.staleHint":
    "Wartość portfela może być nieaktualna do czasu odczytu sald.",
  "rpc.timeoutWarning":
    "RPC Devnet odpowiada zbyt wolno — pokazuję poprzednie dane. Spróbuję ponownie automatycznie.",

  "prices.source": "Ceny: Jupiter (mainnet PreStocks)",
  "prices.stale": "ceny: ostatni odczyt · {time}",
  "prices.unavailable": "Ceny chwilowo niedostępne — wartości po koszcie.",
  "prices.suspect": "niepewna cena",
  "prices.lowLiquidity": "niska płynność",
  "prices.multiplier": "zmiana mnożnika tokena",
  "prices.panelTitle": "Ceny tokenów vs wycena spółek",
  "prices.col.company": "Spółka",
  "prices.col.price": "Cena (USD)",
  "prices.col.premium": "Token vs wycena spółki",
  "prices.col.status": "Status",
  "prices.loading": "Ładowanie cen…",
  "prices.lastRead": "ostatni odczyt · {time}",
  "prices.refresh": "Odśwież ceny",

  "pnl.title": "Zysk/strata",
  "pnl.total": "Łącznie",
  "pnl.atCostValue": "Wartość po koszcie: {value}",
  "pnl.legacyNote": "PnL dostępny dla zakupów po cenie rynkowej (wkrótce).",
  "pnl.partialNote": "PnL tylko dla zakupów po cenie rynkowej; część pozycji po koszcie.",
  "pnl.noPriceNote": "Część zakupów po cenie rynkowej nie ma teraz ceny — PnL pominięty.",
  "pnl.details": "Dodatkowe informacje",
  "pnl.hideDetails": "Ukryj dodatkowe informacje",

  "premium.label": "Token vs wycena spółki",
  "premium.noData": "Token vs wycena: brak danych",
  "premium.above": "{pct} drożej niż wycena",
  "premium.below": "{pct} taniej niż wycena",
  "premium.atValuation": "{pct} — tyle, ile wycena",
  "premium.tooltip": "Różnica między ceną tokena a wyceną spółki z PreStocks",
  "premium.spacex.label": "zniżka vs SPCXx",
  "premium.spacex.value": "zniżka vs SPCXx {pct}",
  "premium.spacex.premiumLabel": "premia vs SPCXx",
  "premium.spacex.premium": "premia vs SPCXx {pct}",
  "premium.spacex.noData": "brak danych",
  "premium.spacex.tooltip":
    "Wartość dodatnia to premia vs SPCXx, ujemna to zniżka vs SPCXx. Różnica obejmuje 6-miesięczny lockup akcji bazowych (do ok. 12.12.2026) i opłatę konwersji ok. 1%, więc nie jest czystą premią IPO. Token PreStocks SPACEX wygasa 12.03.2027 23:59 UTC.",
  "premium.estimate": "szacunek",
  "rank.premiumBasis.server_estimate": "Ranking AI użył premii szacunkowych serwera (nie live). Token vs wycena przy spółkach: live z Jupitera.",
  "rank.premiumBasis.live": "Ranking użył premii live z Jupitera; spółki bez danych liczone bez premii.",
  "rank.premiumBasis.none": "Ranking bez premii (przełącznik wyłączony).",

  "prestocks.snapshotDated":
    "Brak live PreStocks. Użyto statycznego snapshota z {date} (nie live).",

  "tx.priorSession": "Transakcja z poprzedniej sesji weszła: {kind} {tail}",
  "tx.kind.budget": "zmiana budżetu",
  "tx.sessionCheck": "Sprawdzam transakcję z poprzedniej sesji…",
  "tx.err.connectWallet": "Podłącz portfel.",
  "tx.err.noUsdcMint": "Brak NEXT_PUBLIC_USDC_MINT. Ustaw mock mint ({mint}) na Devnet.",
  "tx.err.depositPositive": "Kwota depozytu musi być > 0.",
  "tx.err.firstDepositBudget": "Przy pierwszej wpłacie ustaw budżet tygodniowy > 0 (init + deposit w jednej tx).",
  "tx.err.predcaNotInit": "Predca nie jest zainicjalizowane. Zrób pierwszą wpłatę (Wpłać) — init + deposit w jednej tx.",
  "tx.err.withdrawPositive": "Kwota wypłaty musi być > 0.",
  "tx.err.budgetPositive": "Budżet tygodniowy musi być > 0.",
  "tx.err.missingMints": "Brak mapowania mint dla: {names}. Sprawdź lib/devnet-mock-mints.",
  "tx.err.needThreeMints": "Potrzebne dokładnie 3 tokeny top-3 z mapowaniem mint.",
  "tx.err.noFreeRunIndex": "Brak wolnego indeksu RunRecord (limit skanu). Odśwież i spróbuj ponownie.",
  "tx.err.buyInFlight": "Zakup już w toku.",
  "tx.err.invalidAmount": "Nieprawidłowa kwota",
  "tx.err.unknown": "Nieznany błąd",
  "tx.err.walletRejected": "Transakcja odrzucona w portfelu.",
  "tx.err.rpcDown": "Brak połączenia z RPC (sprawdź NEXT_PUBLIC_RPC_URL / Devnet).{detail}",
  "tx.err.insufficientMock": "Niewystarczające środki (mock USDC). Potrzebujesz salda mock USDC (mint {mint}) na Devnet w ATA portfela. Utwórz ATA i zrób mint/airdrop testowych tokenów, potem Wpłać.",
  "tx.err.missingAta": "Brak konta tokenowego (ATA) dla mock USDC. Na Devnet potrzebujesz ATA dla mint {mint} (np. spl-token create-account {mint} / mint tokenów do portfela). Jeśli Predca nie jest zainicjalizowane — najpierw Initialize.",
  "tx.err.lowWalletUsdc": "Niewystarczające saldo mock USDC w portfelu (mint {mint}). Doładuj ATA przed wpłatą.",
  "tx.vaultLag": "Potwierdzono on-chain; saldo odświeża się. Odśwież Overview albo sprawdź transakcję w explorerze.",
  "tx.sigUnconfirmed": "Nie potwierdzono podpisu transakcji. Sprawdź explorer.",
  "tx.unconfirmedTimeout": "Transakcja wysłana. Devnet jeszcze nie potwierdził — nie wysyłaj jej drugi raz. Sprawdź podpis w explorerze.",
  "tx.confirmStillPending": "Brak potwierdzenia transakcji na Devnet.",
  "tx.failedExpired": "Transakcja nie dotarła do sieci (blockhash wygasł) — możesz spróbować ponownie.",
  "tx.unresolved": "Transakcja niepotwierdzona — sprawdź w explorerze. Nie wysyłaj tej samej operacji, dopóki status się nie wyjaśni.",
  "predca.rpcReadError": "Brak połączenia z RPC Devnet — nie udało się odczytać konta. Dane mogą być nieaktualne. Kliknij Odśwież.",
  "msg.vaultLow": "Za mało USDC w vault: {have} < {need}.",
  "privy.missingWallet": "Brak portfela Privy.",
  "privy.noSignedTx": "Privy nie zwrócił podpisanej transakcji.",
  "privy.noSignatureBytes": "Privy nie zwrócił bajtów podpisu.",
  "privy.notReadyToSign": "Portfel Privy nie jest gotowy do podpisu.",
  "privy.signNotReady": "Portfel Privy jest wybrany, ale podpis jeszcze nie jest gotowy. Spróbuj ponownie.",
  "privy.boundary.title": "Privy przerwało ładowanie",
  "privy.boundary.body": "Strona została na miejscu. Sesja logowania mogła się zapisać — po ponowieniu wybierz Privy jeszcze raz, bez nowego kodu, jeśli e-mail jest już zalogowany.",
  "privy.boundary.retry": "Spróbuj ponownie",
  "auto.signRejected": "Podpis odrzucony: {error}",
  "auto.needSignMessage": "Portfel musi obsługiwać signMessage (włącz auto-buy wymaga podpisu).",
  "auto.weeklySaveFailed": "Nie udało się zapisać kwoty tygodniowej.",
  "rank.source.metricsNoJev": "Źródło: metryki (bez AI — Jev niedostępny)",
  "rank.source.cacheByok": "Źródło: cache serwera (/run/latest) · masz TypeSafe BYOK",
  "rank.source.cacheNoByok": "Źródło: cache serwera (/run/latest) — bez TypeSafe BYOK (nie Jev klienta)",
  "rank.source.grokJev": "Źródło: PreStocks + AI (BYOK · Grok+Jev)",
  "rank.source.jev": "Źródło: PreStocks + AI (BYOK · Jev)",
  "rank.source.dryNoByok": "Źródło: /run/dry bez TypeSafe BYOK (nie Jev klienta)",
  "rank.source.sample": "Źródło: przykładowy wynik (sample) — nie live Jev",
  "rank.source.metricsJevDown": "Źródło: metryki (bez AI — awaria Jev)",
  "rank.source.waiting": "Źródło: PreStocks + AI (BYOK) — czekam na ranking",
  "rank.source.noByok": "Źródło: PreStocks — brak TypeSafe BYOK (wymagany do Jev)",
  "rank.err.hostedUnreachable": "Hosted Jev ({host}) nieosiągalny",
  "rank.err.noDryApi": "Adres API nie jest skonfigurowany — nie można wywołać API /run/dry.",
  "rank.err.noRankProxy": "Adres API nie jest skonfigurowany — nie można użyć proxy /rank.",
  "rank.err.noFaucet": "Adres API nie jest skonfigurowany — nie można użyć faucet /faucet/usdc.",
  "rank.err.faucetNotJson": "API /faucet/usdc HTTP {status} (nie-JSON)",
  "rank.err.hostedDown": "Hosted Jev niedostępny ({error}). Awaryjny ranking metryczny.",
  "rank.err.noApiNoProxy": "Adres API nie jest skonfigurowany i brak same-origin /api/jev — Jev nie może wystartować. Awaryjny ranking metryczny.",
  "rank.err.byokRequired": "Wymagany klucz TypeSafe (BYOK) do Jev — brak darmowego hosted Jev. Awaryjny ranking metryczny.",
  "jev.proxyHint": "Jev niedostępny przez lokalny proxy /api/jev — uruchom npm run dev i sprawdź TYPESAFE_API_KEY.",
  "jev.proxyDown": "Jev proxy niedostępny ({error}). Uruchom aplikację przez npm run dev.",
  "jev.noProxy": "Brak proxy Jev (static Pages). Uruchom npm run dev, żeby Jev działał.",
  "jev.badKey": "Nieprawidłowy TYPESAFE_API_KEY (Jev 401).",
  "jev.noTypesafeKey": "Brak TYPESAFE_API_KEY — Jev nie może wybrać top-3. Awaryjny ranking metryczny.",
  "jev.unavailable": "Jev niedostępny ({error}). Awaryjny ranking metryczny.",
  "prestocks.skippedDirect": "pominięto bezpośrednie prestocks.com",
  "prestocks.corsProxy": "CORS zablokował prestocks.com w przeglądarce — użyto proxy API.",
  "prestocks.sessionFallback": "Nie udało się pobrać live PreStocks (CORS/sieć). Pokazuję ostatni udany fetch z tej sesji.",
  "prestocks.snapshotError": "Błąd PreStocks: {detail}. Brak snapshota.",
};

const en: Dict = {
  "nav.brand": "noir 3.0",
  "nav.overview": "Overview",
  "nav.settings": "Settings",
  "nav.history": "History",
  "nav.selectWallet": "Select Wallet",
  "connect.title": "Connect Wallet",
  "connect.close": "Close",
  "connect.privy": "Privy",
  "connect.privyHint": "Email / Google · separate address",
  "connect.disconnect": "Disconnect",
  "connect.change": "Change wallet",
  "connect.busy": "Connecting…",
  "connect.detected": "Detected",
  "connect.notDetected": "Not detected",
  "connect.notReady": "This wallet is not detected in this browser.",
  "connect.failed": "Could not connect.",
  "connect.timeout": "Connection timed out. Try again.",
  "privy.login": "Login with email / Google (Privy)",
  "privy.connect": "Connect Privy wallet",
  "privy.connected": "Privy {address}",
  "privy.busy": "Privy…",
  "privy.signWait":
    "Approve and close the Privy window to send the transaction",
  "privy.signSuccessHeader": "Signed. Click Close to send.",
  "privy.signSuccessDescription":
    "This has not been sent yet. No funds have moved.",
  "privy.blockhashExpired":
    "The transaction was not sent. No funds moved. Try again and close the Privy window sooner.",

  "overview.kicker": "Trading desk · PreStocks Weekly DCA",
  "overview.title": "Overview",
  "overview.maxDepositHint": "Max deposit: {amount} (wallet balance)",
  "overview.maxWithdrawHint": "Max withdraw: {amount} (vault balance)",
  "overview.disconnectedHint":
    "Wallet disconnected — connect to see on-chain balances. {cluster}.",
  "overview.noMintHint":
    "Set NEXT_PUBLIC_USDC_MINT to a local mock mint.",
  "overview.onChainHint": "On-chain · {cluster} · values from RPC",
  "overview.rpcStale": "last read",
  "overview.clusterMainnet":
    "Warning: RPC looks like Mainnet — this app is Devnet-only. Check NEXT_PUBLIC_RPC_URL.",
  "overview.clusterNotDevnet":
    "Warning: expected Devnet, RPC genesis = {genesis}. Check network / RPC.",

  "faucet.button": "Get 1000 USDC + 0.1 SOL (demo)",
  "faucet.busy": "Sending USDC + SOL…",
  "faucet.success": "Sent 1000 USDC + 0.1 SOL to wallet (demo) · sig {sig}.",
  "faucet.nextSteps": "Next: Deposit into vault (≥ weekly budget) + Generate recommendations — then Purchase unlocks.",
  "faucet.error": "Faucet: {error}",
  "faucet.needWallet": "Connect a wallet to claim demo USDC + SOL.",

  "predca.title": "Predca on-chain ({cluster})",
  "predca.rpc": "RPC:",
  "predca.refresh": "Refresh",
  "predca.loading": "Loading…",
  "predca.budget": "Weekly budget",
  "predca.vault": "Vault",
  "predca.depositTitle": "Deposit",
  "predca.withdrawTitle": "Withdraw",
  "predca.deposit": "Deposit",
  "predca.withdraw": "Withdraw",
  "predca.rpcActionHint": "Inactive — no Devnet RPC connection. Click Refresh.",
  "predca.hintNoAta":
    "Hint: no mock USDC ATA — Deposit usually fails until you have a token account for mint {mint} on Devnet.",
  "predca.hintZeroUsdc":
    "Hint: mock USDC balance = 0 — fund the ATA (mint {mint}) before Deposit.",
  "predca.mintLabel": "Mock USDC mint:",
  "predca.mintNoAta":
    "· No ATA / balance — create a token account and mint test USDC on Devnet before Deposit.",
  "predca.initBudget": "Weekly budget (USDC)",
  "predca.initialize": "Initialize",
  "predca.waiting": "Waiting…",
  "predca.initHint":
    "First deposit = initialize_user + deposit in one tx. Weekly budget comes from Settings (same amount). Change it in Settings, then deposit USDC from the wallet ATA.",
  "predca.rentHint":
    "Hint: init creates UserConfig + vault ATA — you need ~0.002–0.003 SOL for rent (account fee).",
  "predca.depositUnavailable":
    "Deposit unavailable ({reason}). Connect a wallet with the USDC mint configured to deposit.",
  "predca.status.loading": "loading…",
  "predca.status.no_mint": "no mint",
  "predca.status.disconnected": "no wallet",
  "predca.status.error": "error",
  "predca.lastRun": "Last RunRecord on-chain",
  "predca.runMintAddress": "Mint address: {mint}",

  "tile.sol": "SOL",
  "tile.usdcWallet": "USDC (wallet)",
  "tile.portfolioPreStock": "PreStock portfolio value",
  "tile.portfolioHint":
    "PreStock portfolio value: vault USDC + token value (v2 buys at the market price; older 1:1 buys at cost). Wallet USDC is separate.",

  "holdings.titleOnChain": "Holdings allocation (on-chain ATAs)",
  "holdings.titleOffline": "Holdings allocation (offline)",
  "holdings.titleDisconnected": "Holdings allocation",
  "holdings.emptyConnected":
    "No non-zero mock PreStock ATA balances — run a buy (simulate_buy_v2) or wait for the mint.",
  "holdings.empty": "No holdings.",
  "holdings.emptyDisconnected": "Connect wallet to see on-chain holdings.",
  "holdings.allocation": "allocation",
  "holdings.share": "share",

  "top3.title": "Top-3 · recommendations",
  "top3.titleLive": "Top-3 · ranking (live)",
  "top3.restored": "from {time}",
  "btn.generate": "Generate recommendations",
  "btn.generating": "Generating…",
  "btn.purchase": "Purchase",
  "btn.confirm": "Confirm",
  "btn.cancel": "Cancel",
  "btn.buying": "Buying…",
  "btn.waiting": "Waiting for confirmation…",
  "btn.txPending": "Transaction…",
  "empty.generateTips": "Click Generate recommendations.",
  "empty.connectWallet": "Connect wallet, then generate recommendations.",

  "lastPurchase.titleOnChain": "Last purchase (on-chain)",
  "lastPurchase.titleConnected": "Last purchase",
  "lastPurchase.titleOffline": "Last purchase (offline)",
  "lastPurchase.titleDisconnected": "Last purchase",
  "lastPurchase.emptyConnected":
    "No RunRecord — make the first purchase (simulate_buy_v2).",
  "lastPurchase.empty": "No saved purchases.",
  "lastPurchase.emptyDisconnected": "Connect wallet to see on-chain purchases.",
  "lastPurchase.date": "Date:",
  "lastPurchase.budget": "Budget:",
  "lastPurchase.perToken":
    "· split equally across 3 companies (~${amount} each; share count depends on price)",
  "lastPurchase.bought": "Bought:",

  "msg.noTop3Proxy": "Proxy /rank returned no top3.",
  "msg.noTypesafeKey": "Missing TYPESAFE_API_KEY in Settings",
  "msg.tooFewProducts": "Too few PreStocks products for ranking (<3).",
  "purchase.disabled.tx": "Transaction in progress…",
  "purchase.disabled.noRecs": "Purchase disabled — click Generate recommendations first (top-3).",
  "purchase.disabled.notReady": "Purchase disabled — deposit USDC on Overview first (the account is created with that deposit).",
  "purchase.disabled.rpcError": "Purchase disabled — no Devnet RPC connection. Click Refresh.",
  "purchase.disabled.flatRanking": "Purchase disabled — the backup ranking can't tell names apart (all 50.0). Try again later or turn on “IPO premium matters”.",
  "purchase.confirmBudget": "I'll change the on-chain budget from {from} to {to} and buy. Confirm?",
  "purchase.disabled.vaultLow": "Purchase disabled — vault has {have}, need ≥ {need}. Deposit from wallet (faucet fills wallet, not vault).",
  "purchase.disabled.generic": "Purchase disabled — check vault, ranking, and Predca status.",
  "tx.recheck": "Check again",
  "tx.rechecking": "Checking…",
  "dup.warn": "The previous {action} ({amount}) is still unconfirmed and may land. Send another?",
  "dup.sendAnyway": "Send anyway",
  "dup.action.deposit": "deposit",
  "dup.action.withdraw": "withdrawal",
  "dup.action.buy": "purchase",
  "dup.prevConfirmed": "Your previous {action} went through. Click again to send a new one.",
  "msg.noRecs": "No recommendations to purchase.",
  "msg.vaultLowOnChain":
    "Not enough USDC in vault (on-chain): {have} < {need}.",
  "msg.purchaseOk":
    "On-chain purchase OK · sig {sig}… · ${amount} from vault → {tokens}",
  "buy.preview": "≈ {legs}",
  "buy.previewLeg": "{tokens} {name} at {price}",
  "buy.stepAta": "Step 1/2: creating token accounts (signature)",
  "buy.stepBuy": "Step 2/2: purchase (signature)",
  "buy.ataCreatedNoVault":
    "Token accounts were created, but the purchase did not go through. Vault funds were not touched.",
  "buy.ataUnconfirmedNoBuy":
    "Token accounts were not confirmed. The purchase was not sent. Vault funds were not touched.",
  "tx.ok.initDeposit": "Initialized Predca and deposited ${amount} into the vault.",
  "tx.ok.deposit": "Deposited ${amount} into the vault.",
  "tx.ok.withdraw": "Withdrew ${amount} from the vault.",
  "tx.ok.budget": "Saved the weekly budget on-chain.",
  "tx.ok.buyConfirmed": "On-chain purchase confirmed: ${amount} from the vault.",
  "tx.ok.buyConfirmedShort": "On-chain purchase confirmed.",
  "tx.ok.simulateBuy":
    "On-chain purchase (simulate_buy_v2): ${amount} from the vault → ⅓ across {names}.{preview}",
  "tx.buyPreviewLeg": "≈ {tokens} {name} at ${price}",
  "tx.err.noBuyIx": "No purchase instruction.",
  "tx.err.rejected": "Transaction rejected by Devnet. {signature}",
  "tx.err.rejectedShort": "Transaction rejected by Devnet.",
  "msg.purchaseFail":
    "Purchase failed — see details in the Predca section above (red message).",
  "msg.purchasePending":
    "Purchase sent, Devnet has not confirmed yet · {sig} {url}. Don't send it again.",
  "msg.updatingBudget": "Updating budget on-chain…",
  "msg.budgetSyncFail":
    "Could not update on-chain budget before purchase.",
  "msg.predcaNotReady":
    "Predca is not ready — deposit USDC on Overview (the account is created with that deposit), then buy on-chain.",
  "msg.vaultLowMock":
    "Not enough USDC in vault (mock): {have} < {need}.",
  "msg.purchaseOffline":
    "Purchase saved (offline mock): ${amount} from vault → ⅓ to {tokens}",
  "msg.connectForPurchase":
    "Connect a wallet and deposit USDC on Overview to buy on-chain.",
  "msg.purchaseError": "Purchase could not be completed.",
  "msg.autoNoRecs": "Auto-buy: ranking did not return a top-3.",

  "auto.status.off": "Auto-buy is off — enable it in Settings.",
  "auto.status.next": "Next automatic vault purchase: {when}",
  "auto.status.due":
    "Auto-buy is due — ranking and vault purchase will run on their own.",
  "auto.status.ranking": "Auto-buy: generating ranking (Grok→Jev)…",
  "auto.status.buying":
    "Auto-buy: first purchase — sign the transaction in your wallet.",
  "auto.status.buyingKeeper":
    "Auto-buy: keeper is purchasing from the vault (no wallet signature).",
  "auto.status.keeperDown":
    "Keeper unavailable (tunnel or service). This tab does not buy on its own — try again later or check the connection.",
  "auto.status.ok":
    "Weekly auto-buy OK · ${amount} from vault → {tokens}",
  "auto.status.okWithNext":
    "Weekly auto-buy OK · ${amount} from vault → {tokens} · next buy: {nextBuy}",
  "auto.status.vaultLow":
    "Auto-buy paused — not enough USDC in vault ({have} < {need}).",
  "auto.status.needWallet":
    "Connect a wallet to start the keeper (pubkey only — the bot performs the buy).",
  "auto.status.notReady":
    "Deposit USDC on Overview first — the Predca account is created with the first deposit.",
  "auto.status.stillLoading":
    "Predca is still loading — try enabling auto-buy again in a moment.",
  "auto.status.needVault":
    "Deposit USDC into the vault on Overview first. Auto-buy starts once the vault holds funds.",
  "auto.status.error": "Auto-buy failed: {reason}",
  "auto.error.fallback": "Auto-buy failed. Try again later.",
  "auto.error.insufficient": "Not enough funds for the auto-buy.",
  "auto.error.rejected": "The wallet rejected the request.",
  "auto.error.slippage": "The price moved. Try again later.",
  "auto.error.network": "Network problem. Try again later.",
  "auto.error.simulation": "The transaction simulation failed.",
  "auto.error.predca.6000": "Missing permission.",
  "auto.error.predca.6001": "The amount must be greater than zero.",
  "auto.error.predca.6002": "Not enough balance in the vault.",
  "auto.error.predca.6003": "The weekly budget is invalid.",
  "auto.error.predca.6004": "That purchase slot is taken. Try again.",
  "auto.error.predca.6005": "The mint authority is invalid.",
  "auto.error.predca.6006": "The mint does not match the account.",
  "auto.error.predca.6007": "The top 3 contains duplicate mints.",
  "auto.error.predca.6008": "Too soon. Wait 7 days since the last purchase.",
  "auto.error.predca.6009": "No price for this token yet — the keeper has not set it.",
  "auto.error.predca.6010":
    "The token price is stale. The keeper refreshes prices every few minutes — try again shortly.",
  "auto.error.predca.6011": "The token price is invalid.",
  "auto.error.predca.6012": "The price parameters are invalid.",
  "auto.error.predca.6013": "The price jump is too large.",
  "auto.error.predca.6014": "The price math overflowed.",
  "auto.error.predca.6015":
    "The token amount rounded to zero. The price is too high for this budget.",
  "auto.status.enablePending":
    "The keeper is still finishing enable. Wait — don't send a second enable.",
  "auto.status.enableUnknown":
    "It is unknown whether the keeper finished enabling. Check the auto-buy status.",
  "auto.status.backoff":
    "Auto-buy: retrying shortly (last attempt failed).",
  "auto.banner.ranking": "Weekly vault purchase: ranking…",
  "auto.banner.buying":
    "Weekly vault purchase: keeper (no in-tab signature).",
  "auto.banner.confirming":
    "Weekly vault purchase: waiting for the transaction to confirm.",

  "settings.kicker": "DCA configuration",
  "settings.title": "Settings",
  "settings.intro":
    "The weekly amount saves locally right away (without a wallet — until the first connection). The on-chain account is created with the first deposit on Overview. After that, change the budget with “Save budget on-chain”, Manual Buy, or by enabling auto-buy. BYOK stays in localStorage.",
  "settings.weeklyAmount": "Weekly amount (USDC)",
  "settings.weeklyInvalid": "Enter an amount ≥ 1 USDC, at most 2 decimals.",
  "settings.weeklyAtEnable":
    "Saved locally right away (without a wallet — until the first connection). Until a Predca account exists, the on-chain amount is set by the deposit on Overview.",
  "settings.budgetNeedsDeposit":
    "The local budget is saved. The on-chain amount appears after you deposit USDC on Overview.",
  "settings.autoWeekly": "Automatic weekly purchase from the vault",
  "settings.autoWeeklyHint":
    "Off by default. Enabling takes the amount above and immediately buys 3 PreStocks. That transaction starts the weekly schedule. You will not need to confirm later purchases.",
  "settings.autoWeeklyConfirmTitle": "Enable weekly vault purchases?",
  "settings.autoWeeklyConfirmBody":
    "Continuing will split ${amount} from the vault equally across 3 PreStock companies. You will receive a different number of shares depending on each price. This transaction starts the weekly schedule. You will not need to confirm later purchases.",
  "settings.autoWeeklyConfirmOk": "Continue",
  "settings.autoWeeklyConfirmCancel": "Cancel",
  "settings.keeperModeLive": "Mode: Live (real buys)",
  "settings.keeperModeDryRun": "Mode: Dry-run (no transactions)",
  "settings.keeperModeUnknown": "Keeper mode: unknown",
  "settings.weeklySplit":
    "Split equally across 3 top-3 companies (~${amount} each; share count depends on price)",
  "settings.onChainBudget": "· on-chain:",
  "settings.saveLocal": "Save locally",
  "settings.savedLocal": "Saved locally (no wallet)",
  "settings.noMint": "Missing NEXT_PUBLIC_USDC_MINT",
  "settings.saveOnChain": "Save budget on-chain",
  "settings.savingOnChain": "Saving on-chain…",
  "settings.connectForBudget":
    "Connect a wallet. The local budget saves immediately; the on-chain amount follows a deposit on Overview.",
  "settings.saved": "· saved ✓",
  "settings.cleared": "· cleared ✓",
  "settings.exclusions": "Exclusions (e.g. OpenAI, Kalshi) — applied to ranking",
  "settings.fixedExclusion": "xAI — always excluded (not available in PreStocks DCA)",
  "settings.buyDespiteIpo": "Buy PreStock even after IPO",
  "settings.deadlineInvalid": "Allow tokens past their expiry or with an invalid deadline (they are worthless after the end date).",
  "settings.ipoPremium": "IPO premium matters (factor in token vs market pricing gap, e.g. −20% / +34%).",
  "settings.noData": "no data",
  "settings.noDataTooltip": "The PreStocks API doesn't provide this data yet — the toggle has no effect.",
  "settings.dataKnown": "Data: {list}",
  "settings.dataUnknown": "No data: {names} — these names are not filtered.",
  "settings.dataStale": "Stale (> 7 days): {names}.",
  "settings.ipoListed": "listed {date}",
  "settings.ipoAnnounced": "IPO planned {date}",
  "settings.deadlineOn": "deadline {date}",
  "settings.checkedOn": "checked {date}",
  "settings.prefsDirtyHint":
    "Settings changed. Sign a wallet message to save them to the keeper.",
  "settings.prefsSignSave": "Sign & save",
  "settings.prefsSignSaving": "Signing…",
  "settings.prefsConnectWallet": "Connect wallet to sign and save",
  "settings.prefsSignNeedWallet": "Connect a wallet with signMessage to save",
  "settings.prefsSignFailed": "Could not save (signature or keeper).",
  "settings.prefsSignOk": "Saved to keeper ✓",
  "settings.prefsLoading": "Loading keeper settings…",
  "settings.byokTitle": "BYOK — Bring Your Own API Keys",
  "settings.byokIntro":
    "The Jev demo key is filled in. Paste your own to override.",
  "settings.byokIntroEmpty": "Paste your TypeSafe (Jev) key.",
  "settings.typesafeLabel":
    "(Jev) — demo key is filled in; paste your own to override",
  "settings.typesafeLabelEmpty": "(Jev) — paste your TypeSafe key",
  "settings.xaiLabel":
    "/ Grok — optional client key for Grok analysis (sent to the ranking API); empty = Jev/metrics without Grok. Jev uses the TypeSafe key from the field above.",
  "settings.show": "Show",
  "settings.hide": "Hide",
  "settings.saveKeys": "Save keys to localStorage",
  "settings.keysSaved": "Saved to localStorage ✓",

  "history.kicker": "DCA runs",
  "history.title": "History",
  "history.onChainIntro":
    "RunRecord on-chain · {count} entries ({cluster}).",
  "history.connectHint":
    "Connect your wallet to see purchase history (RunRecord) from Predca.",
  "history.noRuns":
    "No on-chain RunRecord yet — make a purchase (simulate_buy_v2) or wait for record_run.",
  "history.notReady":
    "Predca is not ready — deposit USDC on Overview, then runs will appear.",
  "history.fetchError": "Couldn't load history",
  "history.staleRuns": "Last read — RPC unavailable, data may be stale.",
  "history.loading": "Loading on-chain history…",
  "history.runMeta": "Run #{index} · budget ~{budget} · slot {slot}",
  "history.runMetaUnknown": "Run #{index} · budget {unknown} · slot {slot}",
  "history.buyPrice": "at {price} · {units} units",
  "history.legPnl": "now {value} · {pnl}",
  "history.runPnl": "P/L: {pnl}",

  "positions.title": "Positions",
  "positions.col.asset": "Asset",
  "positions.col.units": "Units",
  "positions.col.price": "Price now",
  "positions.col.value": "Value",
  "positions.col.avgBuy": "Avg buy price",
  "positions.col.pnl": "P/L",
  "positions.noData": "no data",
  "positions.atCost": "at cost (1:1 buy before v2)",
  "positions.legacyHint":
    "Earlier Devnet buys minted tokens 1:1 to USDC — they are valued at cost.",
  "positions.mismatch": "Token balance differs from purchase history.",
  "runPrice.loading": "purchase price is loading",
  "runPrice.unknown": "—",
  "balances.warning":
    "Token balances are temporarily unavailable — showing the previous ones. Refresh in a moment.",
  "portfolio.staleHint":
    "Portfolio value may be out of date until balances load.",
  "rpc.timeoutWarning":
    "Devnet RPC is responding slowly — showing the previous data. Retrying automatically.",

  "prices.source": "Prices: Jupiter (mainnet PreStocks)",
  "prices.stale": "prices: last read · {time}",
  "prices.unavailable": "Prices unavailable — values at cost.",
  "prices.suspect": "uncertain price",
  "prices.lowLiquidity": "low liquidity",
  "prices.multiplier": "token multiplier change",
  "prices.panelTitle": "Token prices vs company valuation",
  "prices.col.company": "Company",
  "prices.col.price": "Price (USD)",
  "prices.col.premium": "Token vs valuation",
  "prices.col.status": "Status",
  "prices.loading": "Loading prices…",
  "prices.lastRead": "last read · {time}",
  "prices.refresh": "Refresh prices",

  "pnl.title": "Profit/loss",
  "pnl.total": "Total",
  "pnl.atCostValue": "Value at cost: {value}",
  "pnl.legacyNote": "PnL available for purchases at market price (coming soon).",
  "pnl.partialNote": "PnL only for market-price purchases; some positions are at cost.",
  "pnl.noPriceNote": "Some market-price purchases have no current price — P/L skipped.",
  "pnl.details": "Additional Info",
  "pnl.hideDetails": "Hide additional info",

  "premium.label": "Token vs valuation",
  "premium.noData": "Token vs valuation: no data",
  "premium.above": "{pct} above valuation",
  "premium.below": "{pct} below valuation",
  "premium.atValuation": "{pct} — at valuation",
  "premium.tooltip": "Difference between the token price and the company valuation from PreStocks",
  "premium.spacex.label": "discount vs SPCXx",
  "premium.spacex.value": "discount vs SPCXx {pct}",
  "premium.spacex.premiumLabel": "premium vs SPCXx",
  "premium.spacex.premium": "premium vs SPCXx {pct}",
  "premium.spacex.noData": "no data",
  "premium.spacex.tooltip":
    "A positive value is a premium vs SPCXx; a negative value is a discount vs SPCXx. The difference includes a 6-month lockup of the underlying shares (until about 12 Dec 2026) and a conversion fee of about 1%, so it is not a pure IPO premium. The PreStocks SPACEX token expires 12 Mar 2027 23:59 UTC.",
  "premium.estimate": "estimate",
  "rank.premiumBasis.server_estimate": "AI ranking used the server's estimated premiums (not live). Token vs valuation shown next to each name is live from Jupiter.",
  "rank.premiumBasis.live": "Ranking used live Jupiter premiums; names without data scored without a premium.",
  "rank.premiumBasis.none": "Ranking ignores premiums (toggle off).",

  "prestocks.snapshotDated":
    "No live PreStocks. Using static snapshot from {date} (not live).",

  "tx.priorSession": "Transaction from the previous session landed: {kind} {tail}",
  "tx.kind.budget": "budget change",
  "tx.sessionCheck": "Checking the transaction from the previous session…",
  "tx.err.connectWallet": "Connect a wallet.",
  "tx.err.noUsdcMint": "Missing NEXT_PUBLIC_USDC_MINT. Set the mock mint ({mint}) on Devnet.",
  "tx.err.depositPositive": "Deposit amount must be > 0.",
  "tx.err.firstDepositBudget": "On the first deposit, set a weekly budget > 0 (init + deposit in one tx).",
  "tx.err.predcaNotInit": "Predca is not initialized. Make the first deposit (Deposit) — init + deposit in one tx.",
  "tx.err.withdrawPositive": "Withdrawal amount must be > 0.",
  "tx.err.budgetPositive": "Weekly budget must be > 0.",
  "tx.err.missingMints": "No mint mapping for: {names}. Check lib/devnet-mock-mints.",
  "tx.err.needThreeMints": "Exactly 3 top-3 tokens with a mint mapping are required.",
  "tx.err.noFreeRunIndex": "No free RunRecord index (scan limit). Refresh and try again.",
  "tx.err.buyInFlight": "A purchase is already in progress.",
  "tx.err.invalidAmount": "Invalid amount",
  "tx.err.unknown": "Unknown error",
  "tx.err.walletRejected": "Transaction rejected in the wallet.",
  "tx.err.rpcDown": "No RPC connection (check NEXT_PUBLIC_RPC_URL / Devnet).{detail}",
  "tx.err.insufficientMock": "Insufficient funds (mock USDC). You need a mock USDC balance (mint {mint}) on Devnet in the wallet ATA. Create the ATA and mint/airdrop test tokens, then Deposit.",
  "tx.err.missingAta": "No token account (ATA) for mock USDC. On Devnet you need an ATA for mint {mint} (for example spl-token create-account {mint} / mint tokens to the wallet). If Predca is not initialized — Initialize first.",
  "tx.err.lowWalletUsdc": "Insufficient mock USDC balance in the wallet (mint {mint}). Fund the ATA before depositing.",
  "tx.vaultLag": "Confirmed on-chain; the balance is refreshing. Refresh Overview or check the transaction in the explorer.",
  "tx.sigUnconfirmed": "The transaction signature was not confirmed. Check the explorer.",
  "tx.unconfirmedTimeout": "Transaction sent. Devnet has not confirmed it yet — do not send it a second time. Check the signature in the explorer.",
  "tx.confirmStillPending": "No transaction confirmation on Devnet.",
  "tx.failedExpired": "The transaction did not reach the network (blockhash expired) — you can try again.",
  "tx.unresolved": "Transaction unconfirmed — check the explorer. Do not send the same operation until the status is clear.",
  "predca.rpcReadError": "No Devnet RPC connection — could not read the account. Data may be out of date. Click Refresh.",
  "msg.vaultLow": "Not enough USDC in the vault: {have} < {need}.",
  "privy.missingWallet": "No Privy wallet.",
  "privy.noSignedTx": "Privy did not return a signed transaction.",
  "privy.noSignatureBytes": "Privy did not return signature bytes.",
  "privy.notReadyToSign": "The Privy wallet is not ready to sign.",
  "privy.signNotReady": "The Privy wallet is selected, but signing is not ready yet. Try again.",
  "privy.boundary.title": "Privy stopped loading",
  "privy.boundary.body": "The page stayed in place. The login session may have been saved — after retrying, choose Privy again, without a new code, if the email is already logged in.",
  "privy.boundary.retry": "Try again",
  "auto.signRejected": "Signature rejected: {error}",
  "auto.needSignMessage": "The wallet must support signMessage (enabling auto-buy requires a signature).",
  "auto.weeklySaveFailed": "Could not save the weekly amount.",
  "rank.source.metricsNoJev": "Source: metrics (no AI — Jev unavailable)",
  "rank.source.cacheByok": "Source: server cache (/run/latest) · you have a TypeSafe BYOK",
  "rank.source.cacheNoByok": "Source: server cache (/run/latest) — without TypeSafe BYOK (not the client's Jev)",
  "rank.source.grokJev": "Source: PreStocks + AI (BYOK · Grok+Jev)",
  "rank.source.jev": "Source: PreStocks + AI (BYOK · Jev)",
  "rank.source.dryNoByok": "Source: /run/dry without TypeSafe BYOK (not the client's Jev)",
  "rank.source.sample": "Source: sample result — not live Jev",
  "rank.source.metricsJevDown": "Source: metrics (no AI — Jev failure)",
  "rank.source.waiting": "Source: PreStocks + AI (BYOK) — waiting for the ranking",
  "rank.source.noByok": "Source: PreStocks — no TypeSafe BYOK (required for Jev)",
  "rank.err.hostedUnreachable": "Hosted Jev ({host}) unreachable",
  "rank.err.noDryApi": "API address is not configured — cannot call API /run/dry.",
  "rank.err.noRankProxy": "API address is not configured — cannot use the /rank proxy.",
  "rank.err.noFaucet": "API address is not configured — cannot use faucet /faucet/usdc.",
  "rank.err.faucetNotJson": "API /faucet/usdc HTTP {status} (not JSON)",
  "rank.err.hostedDown": "Hosted Jev unavailable ({error}). Fallback metric ranking.",
  "rank.err.noApiNoProxy": "API address is not configured and there is no same-origin /api/jev — Jev cannot start. Fallback metric ranking.",
  "rank.err.byokRequired": "A TypeSafe key (BYOK) is required for Jev — there is no free hosted Jev. Fallback metric ranking.",
  "jev.proxyHint": "Jev is unavailable through the local proxy /api/jev — run npm run dev and check TYPESAFE_API_KEY.",
  "jev.proxyDown": "Jev proxy unavailable ({error}). Run the app with npm run dev.",
  "jev.noProxy": "No Jev proxy (static Pages). Run npm run dev so Jev works.",
  "jev.badKey": "Invalid TYPESAFE_API_KEY (Jev 401).",
  "jev.noTypesafeKey": "Missing TYPESAFE_API_KEY — Jev cannot pick a top-3. Fallback metric ranking.",
  "jev.unavailable": "Jev unavailable ({error}). Fallback metric ranking.",
  "prestocks.skippedDirect": "skipped direct prestocks.com",
  "prestocks.corsProxy": "CORS blocked prestocks.com in the browser — used the API proxy.",
  "prestocks.sessionFallback": "Could not fetch live PreStocks (CORS/network). Showing the last successful fetch from this session.",
  "prestocks.snapshotError": "PreStocks error: {detail}. No snapshot.",
};

const dictionaries: Record<Locale, Dict> = { pl, en };

type Vars = Record<string, string | number>;

function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    vars[key] != null ? String(vars[key]) : `{${key}}`,
  );
}

export function translate(
  locale: Locale,
  key: string,
  vars?: Vars,
): string {
  const dict = dictionaries[locale] ?? dictionaries.pl;
  const raw = dict[key] ?? dictionaries.pl[key] ?? dictionaries.en[key] ?? key;
  return interpolate(raw, vars);
}

/** Sentence for a toast or error, in the language active when it is shown. */
export function shown(key: string, vars?: Vars): string {
  return translate(getLocaleSnapshot(), key, vars);
}

/**
 * Plain digits (no "$"). The browser locale picks separators; the PL/EN
 * switch does not. `locale` stays so existing callers keep compiling.
 */
export function formatCount(
  locale: Locale,
  amount: number,
  opts?: { min?: number; max?: number },
): string {
  void locale;
  if (!Number.isFinite(amount)) return "";
  return formatGrouped(amount, { min: opts?.min, max: opts?.max ?? 6 });
}

type I18nContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, vars?: Vars) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  // Server and the hydration render use DEFAULT_LOCALE. The stored language
  // is applied on the client snapshot, immediately after hydration.
  const locale = useSyncExternalStore(
    subscribeLocale,
    getLocaleSnapshot,
    getLocaleServerSnapshot,
  );
  // Hydration uses en-US. The client snapshot then switches to the browser.
  const browserNumbers = useSyncExternalStore(
    subscribeNumberLocale,
    readBrowserNumberLocale,
    () => NUMBER_LOCALE_FALLBACK,
  );
  syncNumberLocale(browserNumbers);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    writeStoredLocale(next);
    document.documentElement.lang = next;
  }, []);

  const t = useCallback(
    (key: string, vars?: Vars) => translate(locale, key, vars),
    [locale],
  );

  const value = useMemo(
    () => ({ locale, setLocale, t }),
    [locale, setLocale, t],
  );

  return (
    <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
  );
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useI18n must be used within I18nProvider");
  }
  return ctx;
}
