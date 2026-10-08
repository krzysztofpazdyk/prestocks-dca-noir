# PreStocks DCA Noir v4.31

Tygodniowy desk DCA na PreStocks (Solana **Devnet**). Budżet tygodniowy jest dzielony równo na top-3 z rankingu Jev. Zakup idzie z vaulta USDC programu **predca** po podpisie portfela. Auto-zakup robi keeper.

**Live:** https://krzysztofpazdyk.github.io/prestocks-dca-noir/  
`basePath` / `assetPrefix`: `/prestocks-dca-noir`

## Skąd jest v4.31

Promocja 1:1 z [`prestocks-dca-noir2.0`](https://github.com/krzysztofpazdyk/prestocks-dca-noir2.0) @ `041df90` (tag `v4.31`). Różnią się tylko basePath, workflow Pages i ten README.

- **Poprzedni stabilny noir:** v4.08 (`9de6b7f`, tag `noir-v4.08-przed-promocja`).
- **Najważniejsze zmiany od v4.08:**
  - **Niepotwierdzona transakcja:** timeout potwierdzenia to „pending”, a nie błąd. Po oknie zawsze jest werdykt (weszła / odrzucona / nie dotarła / niepotwierdzona). Podpis jest pamiętany po F5 (`localStorage`) i jest „Sprawdź ponownie”. Druga taka sama operacja wymaga „Wyślij mimo to” (v4.18, v4.27, v4.30, v4.31).
  - **Bez podwójnej wysyłki:** synchroniczne blokady Kup / Wpłać / Wypłać i odzysk kolizji `runIndex` (v4.17, v4.27, v4.30).
  - **Błąd RPC to nie brak konta:** ostatni odczyt zostaje („ostatni odczyt”), Wpłata i Wypłata są widoczne, ale wyszarzone, nie ma `initialize_user` przy nieznanym stanie (v4.30, v4.31).
  - **Auto-zakup:**
    - `/enable` jest idempotentne, a timeout to pending + poll, bez drugiego zakupu,
    - przełącznik On zapisuje się dopiero po prawdziwym starcie,
    - Off działa także w trakcie transakcji (v4.15, v4.19, v4.21, v4.30).
  - **Zmiana portfela:** odczyty i autoryzacja keepera są per portfel, a spóźnione odświeżenie nie nadpisuje nowego portfela (v4.16, v4.20).
  - **Logowanie e-mailem (Privy, embedded wallet Devnet)** obok Phantoma i Solflare. Jest jeden przycisk „Rozłącz”, a po polsku przycisk portfela to „Zaloguj” (v4.09–v4.14, v4.23, v4.28, v4.29).
  - **Ranking Jev działa od pierwszej wizyty** dzięki domyślnemu kluczowi demo TypeSafe (v4.22, v4.25).
  - **Polskie etykiety:** „Wpłać” / „Wypłać”, podpowiedzi przez i18n (v4.26, v4.31).
  - **135 testów automatycznych** (`scripts/*.test.ts`).

## Co widać w UI

- **Logowanie:** „Zaloguj”, potem Privy (e-mail + kod OTP → portfel Solana w przeglądarce) albo Phantom / Solflare (sieć **Devnet**).
- **Pierwsza wpłata** wysyła `initialize_user` i `deposit_usdc` w jednej transakcji. Osobnego kroku Initialize nie ma.
- **Faucet demo:** 1000 USDC + 0.1 SOL na portfel (Devnet).
- **Ranking:** Jev potrzebuje klucza TypeSafe. Build Pages wstawia klucz demo do `localStorage` przy pierwszej wizycie. Własny klucz albo jego wyczyszczenie w Ustawieniach zostaje. Klucz xAI jest opcjonalny (komentarz Groka).
- **Transakcje:** amber „Czekam na potwierdzenie…” z linkiem do explorera. Po werdykcie widać zielony sukces albo czerwony błąd, a przy niepotwierdzonej tx przycisk „Sprawdź ponownie”.

## Znane ograniczenia (odłożone do mainnetu)

- **Klucz demo TypeSafe jest w bundlu JS** (`NEXT_PUBLIC_TYPESAFE_DEFAULT_KEY` jest wstawiany przez Next do klienta). Celowe na Devnet. Przed mainnetem trzeba go wyjąć albo dać proxy.
- **Kaprysy przełączania portfela Privy ↔ Phantom:**
  - po „Rozłącz” Privy od razu nic nie robi,
  - modal Phantom→Privy sam się zamyka,
  - prompt „Sign message” keepera przy każdym połączeniu,
  - blokada Phantoma nie jest wykrywana,
  - Esc zostawia „Łączenie…”,
  - wiszący podpis psuje szybkie ponowne połączenie.
- **F5 w pierwszych ~30 s** wysyłki (przed timeoutem web3) nie ma podpisu do zapamiętania.

## Konfiguracja

| | Wartość |
|---|---|
| Program Devnet (predca) | `HajLzgcp6fyHVgVLFtwujnU53re47PSMJcQZZes8ZvbU` |
| Mint mock USDC | `99UbouJx2ZTLThQkqxrQGLZkDAYAn9vv8n6qnQh5f4Sw` |
| RPC | `https://api.devnet.solana.com` |
| Ranking / keeper | `https://predca-api.onrender.com`, `https://predca-api.onrender.com/keeper` |
| Privy App ID (publiczny) | `cmuf3rgpj01rb0cjpl6ked6f4`; dozwolone originy: `https://krzysztofpazdyk.github.io`, `http://localhost:3000` |

Publiczna konfiguracja buildu jest w `.env.production`. Nie ma w niej sekretów: `NEXT_PUBLIC_PRIVY_APP_ID` i `NEXT_PUBLIC_TYPESAFE_DEFAULT_KEY` są tam puste i przychodzą z workflow.

noir i noir2.0 działają na tym samym originie (`krzysztofpazdyk.github.io`), więc dzielą `localStorage` i sesję Privy. Oba używają tego samego programu, mintu i keepera, więc współdzielony stan jest spójny.

## Lokalnie

Node.js 20+ (CI: 22), katalog repozytorium `prestocks-dca-noir`. `.npmrc` ma `legacy-peer-deps=true` (opcjonalny peer EVM Privy).

```bash
cp .env.example .env.local      # dla Devnet skopiuj wartości z .env.production
npm ci
npm run dev                     # http://localhost:3000/prestocks-dca-noir/
```

Opcjonalnie w `.env.local`: `NEXT_PUBLIC_PRIVY_APP_ID` (bez niego jest tylko Phantom / Solflare) i `NEXT_PUBLIC_TYPESAFE_DEFAULT_KEY` (nie commitować).

Sprawdzenia:

```bash
npx tsc --noEmit
npx tsx --test scripts/*.test.ts         # 135 testów
npx eslint
NODE_ENV=production npm run build        # static export → out/ (scripts/static-export.mjs)
```

## Deploy

Push do `main` (albo ręczny `workflow_dispatch`) uruchamia GitHub Actions [`.github/workflows/pages.yml`](.github/workflows/pages.yml): `npm ci`, potem `npm run build` → `out/` → GitHub Pages.

Build dostaje:
- `NEXT_PUBLIC_PRIVY_APP_ID` (jawna wartość w workflow),
- `NEXT_PUBLIC_TYPESAFE_DEFAULT_KEY` z sekretu repo o tej samej nazwie.

PR-y i inne branche **nie** deployują.
