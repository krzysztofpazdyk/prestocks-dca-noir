# PreStocks DCA Noir v4.02

Tygodniowy desk DCA na PreStocks (Solana **Devnet**). Równy podział budżetu na top-3. Zakup idzie z vaulta USDC programu **predca**, po podpisie portfela. Klucze BYOK zostają w `localStorage`.

**Live:** https://krzysztofpazdyk.github.io/prestocks-dca-noir/  
`basePath` `/prestocks-dca-noir`

## Skąd jest v4.02

Produkt wjechał z [`prestocks-dca-noir2.0`](https://github.com/krzysztofpazdyk/prestocks-dca-noir2.0) @ `a115722` (v3.47) jako v4.0.

- **v4.01** — baner auto-zakupu i budżet w `localStorage` są przypisane do pubkeya portfela.
- **v4.02** — domyślny budżet tygodniowy to **$150**, gdy portfel nie ma własnego zapisu.

## Co widać w UI

- **Pierwsza wpłata** wysyła `initialize_user` i `deposit_usdc` w jednej transakcji. Osobnego kroku Initialize nie ma.
- **Portfel odłączony:** alokacja holdings jest pusta, bez wykresu. Salda on-chain pokazują się po połączeniu.
- **Phantom (albo inny wallet):** sieć **Devnet**. Build Pages używa `https://api.devnet.solana.com`.
- **Ranking:** klucz TypeSafe w Ustawieniach jest wymagany do Jev. Klucz xAI jest opcjonalny (komentarz Groka).

## API

Keeper i ranking: https://predca-api.onrender.com  
Status keepra: https://predca-api.onrender.com/keeper

Program Devnet: `HajLzgcp6fyHVgVLFtwujnU53re47PSMJcQZZes8ZvbU`  
Mint USDC i adresy RPC są w `.env.production`.

## Lokalnie

Node.js 22, katalog repozytorium `prestocks-dca-noir`.

```bash
cp .env.example .env.local
npm i
npm run dev
```

Dev: http://localhost:3000/prestocks-dca-noir/

`.env.local` powstaje z `.env.example` (localnet, pusty mint, pusty keeper). Build Pages czyta `.env.production`: publiczny Devnet RPC, program, mint USDC i URL-e Rendera. Sekretów w repo nie ma.

## Deploy

Push do `main` uruchamia GitHub Actions [`.github/workflows/pages.yml`](.github/workflows/pages.yml) (`workflow_dispatch` też). Job robi `npm ci`, `npm run build` (static export do `out/`) i wgrywa artefakt na GitHub Pages.
