/**
 * Portfolio marks for Devnet mock balances.
 * Legacy buys minted 1 token per 1 USDC — those units stay at cost.
 * v2 lots (RunPrice) are marked at the Jupiter UI price when we have one.
 */

import { nameByMint } from "@/lib/devnet-mock-mints";
import {
  canonicalName,
  quoteByName,
  type JupPrices,
  type JupQuote,
} from "@/lib/jup-prices";
import { effectiveRunPricePresence } from "@/lib/run-price";

/**
 * `priced` — RunPrice decoded. `legacy` — confirmed missing account (1:1).
 * `unknown` — read missing or failed, or a young run whose account is not
 * confirmed yet. Unknown must not be marked at $1 per token.
 */
export type LotPriceState = "priced" | "legacy" | "unknown";

export type RunLot = {
  name: string;
  devnetMint: string;
  runIndex: number;
  ts: number;
  /** USDC spent on this leg (RunRecord.amounts[i] / 1e6). */
  usdcCost: number;
  /** RunPrice.units[i] / 1e6. null = legacy 1:1 mint. */
  units: number | null;
  /** RunPrice.prices_e6[i] / 1e6. null = legacy. */
  buyPrice: number | null;
  /** Absent on older callers: units set → priced, otherwise legacy. */
  priceState?: LotPriceState;
};

export type RunLotSource = {
  runIndex: number;
  ts: number;
  mints: string[];
  amountsUsd: number[];
};

export type DecodedLots = {
  mints: { toBase58(): string }[];
  /** Older in-memory shape: token base units on the price account. */
  units?: Array<bigint | number>;
  /** Older in-memory shape: USD price scaled 1e6. */
  pricesE6?: Array<bigint | number>;
  /** predca 3.0 RunPrice.prices — USD per whole token, scaled by priceDecimals. */
  prices?: Array<bigint | number>;
  priceDecimals?: Array<number>;
  /** Raw USDC (6 decimals) spent on each leg. */
  usdcSpentEach?: bigint | number;
};

export type TokenAmount = { name: string; amount: number };

export type PositionRow = {
  name: string;
  units: number;
  /** Cost basis of the tokens still in the balance (after mismatch scaling). */
  costUsd: number;
  pricedUnits: number;
  legacyCostUsd: number;
  priceNow: number | null;
  valueUsd: number;
  pnlUsd: number | null;
  pnlPct: number | null;
  avgBuyPrice: number | null;
  basis: "market" | "cost" | "mixed";
  stale: boolean;
  mismatch: boolean;
  /** False when a v2 buy price is still unknown. Absent means known. */
  valueKnown?: boolean;
};

export const DUST = 0.000001;

function relDiff(a: number, b: number): boolean {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) > DUST * scale;
}

function num(v: bigint | number): number {
  const n = typeof v === "bigint" ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function isPricedRun(dec: DecodedLots): boolean {
  return (
    dec.prices != null ||
    dec.priceDecimals != null ||
    dec.usdcSpentEach != null
  );
}

/**
 * RunRecord legs + optional RunPrice.
 * Confirmed missing account (map value null, run older than ~60s) → legacy 1:1.
 * No map entry, a failed read, or a young run without a decoded account → unknown
 * (not $1 per token). predca 3.0 amounts are minted token base units; USDC spent
 * and the buy price come from RunPrice.
 */
export function runLots(
  runs: RunLotSource[],
  decoded: ReadonlyMap<number, DecodedLots | null>,
  nowMs = Date.now(),
): RunLot[] {
  const lots: RunLot[] = [];
  for (const run of runs) {
    const presence = effectiveRunPricePresence(decoded, run.runIndex, run.ts, nowMs);
    const n = Math.max(run.mints.length, run.amountsUsd.length);
    if (presence === "unknown") {
      for (let i = 0; i < n; i++) {
        const devnetMint = run.mints[i] ?? "";
        if (!devnetMint) continue;
        lots.push({
          name: nameByMint(devnetMint) ?? devnetMint,
          devnetMint,
          runIndex: run.runIndex,
          ts: run.ts,
          usdcCost: 0,
          units: null,
          buyPrice: null,
          priceState: "unknown",
        });
      }
      continue;
    }
    const dec = presence === "decoded" ? (decoded.get(run.runIndex) ?? null) : null;
    for (let i = 0; i < n; i++) {
      const devnetMint = run.mints[i] ?? "";
      if (!devnetMint) continue;
      const name = nameByMint(devnetMint) ?? devnetMint;
      const recordUi = Number(run.amountsUsd[i] ?? 0);
      let usdcCost = Number.isFinite(recordUi) ? recordUi : 0;
      let units: number | null = null;
      let buyPrice: number | null = null;
      const decMint = dec?.mints[i]?.toBase58();
      if (dec && decMint === devnetMint) {
        if (isPricedRun(dec)) {
          const spentRaw = num(dec.usdcSpentEach ?? 0);
          if (Number.isFinite(spentRaw) && spentRaw > 0) usdcCost = spentRaw / 1e6;
          if (Number.isFinite(recordUi) && recordUi >= 0) units = recordUi;
          const rawPx = num(dec.prices?.[i] ?? 0);
          const decimals = dec.priceDecimals?.[i] ?? 6;
          if (
            Number.isFinite(rawPx) &&
            rawPx > 0 &&
            Number.isInteger(decimals) &&
            decimals >= 0 &&
            decimals <= 18
          ) {
            buyPrice = rawPx / 10 ** decimals;
          }
          if ((buyPrice == null || buyPrice <= 0) && units != null && units > 0 && usdcCost > 0) {
            buyPrice = usdcCost / units;
          }
          if (units == null) buyPrice = null;
        } else {
          const rawUnits = num(dec.units?.[i] ?? 0);
          const rawPx = num(dec.pricesE6?.[i] ?? 0);
          if (Number.isFinite(rawUnits) && rawUnits >= 0) units = rawUnits / 1e6;
          if (Number.isFinite(rawPx) && rawPx > 0) buyPrice = rawPx / 1e6;
          if (units == null) buyPrice = null;
        }
      }
      lots.push({
        name,
        devnetMint,
        runIndex: run.runIndex,
        ts: run.ts,
        usdcCost: Number.isFinite(usdcCost) ? usdcCost : 0,
        units,
        buyPrice,
        priceState: units != null ? "priced" : "legacy",
      });
    }
  }
  return lots;
}

function lotState(lot: RunLot): LotPriceState {
  if (lot.priceState === "unknown" || lot.priceState === "priced" || lot.priceState === "legacy") {
    return lot.priceState;
  }
  return lot.units != null ? "priced" : "legacy";
}

function listed(names: string[], name: string): boolean {
  const want = canonicalName(name);
  return names.some((n) => canonicalName(n) === want);
}

/**
 * One row per token balance > 0.
 * Legacy units are $1 of cost each. A smaller balance scales v2 units and
 * legacy cost together (and the v2 USDC cost, so avg buy stays put).
 * A larger balance is extra legacy at $1.
 */
export function buildPositions(
  lots: RunLot[],
  balances: TokenAmount[],
  prices: JupPrices,
): PositionRow[] {
  const lotsByName = new Map<string, RunLot[]>();
  for (const lot of lots) {
    const key = canonicalName(lot.name);
    const list = lotsByName.get(key) ?? [];
    list.push(lot);
    lotsByName.set(key, list);
  }

  const rows: PositionRow[] = [];
  const seen = new Set<string>();
  for (const bal of balances) {
    if (!Number.isFinite(bal.amount) || bal.amount <= 0) continue;
    const key = canonicalName(bal.name);
    if (seen.has(key)) continue;
    seen.add(key);
    const group = lotsByName.get(key) ?? [];
    const quote: JupQuote | undefined = quoteByName(prices.quotes, bal.name);
    const priceNow = quote?.usdPrice ?? null;
    const stale =
      prices.source === "cache" ||
      listed(prices.suspect, bal.name) ||
      listed(prices.carried ?? [], bal.name);
    if (group.some((lot) => lotState(lot) === "unknown")) {
      rows.push({
        name: bal.name,
        units: bal.amount,
        costUsd: 0,
        pricedUnits: 0,
        legacyCostUsd: 0,
        priceNow,
        valueUsd: 0,
        pnlUsd: null,
        pnlPct: null,
        avgBuyPrice: null,
        basis: "cost",
        stale,
        mismatch: false,
        valueKnown: false,
      });
      continue;
    }
    let pricedUnits = 0;
    let v2Cost = 0;
    let legacyCost = 0;
    for (const lot of group) {
      if (lot.units != null) {
        pricedUnits += lot.units;
        v2Cost += lot.usdcCost;
      } else {
        legacyCost += lot.usdcCost;
      }
    }

    const balance = bal.amount;
    const expected = pricedUnits + legacyCost;
    let mismatch = false;
    if (relDiff(balance, expected)) {
      mismatch = true;
      if (balance < expected) {
        const scale = expected > 0 ? balance / expected : 0;
        pricedUnits *= scale;
        v2Cost *= scale;
        legacyCost *= scale;
      } else {
        legacyCost += balance - expected;
      }
    }

    const v2Active = pricedUnits > DUST;
    const legacyActive = legacyCost > DUST;
    let valueUsd: number;
    let pnlUsd: number | null;
    let pnlPct: number | null;
    let basis: PositionRow["basis"];
    if (v2Active && priceNow != null) {
      const market = pricedUnits * priceNow;
      valueUsd = market + legacyCost;
      pnlUsd = market - v2Cost;
      pnlPct = v2Cost > DUST ? (pnlUsd / v2Cost) * 100 : null;
      basis = legacyActive ? "mixed" : "market";
    } else {
      valueUsd = v2Cost + legacyCost;
      pnlUsd = null;
      pnlPct = null;
      basis = "cost";
    }

    rows.push({
      name: bal.name,
      units: balance,
      costUsd: v2Cost + legacyCost,
      pricedUnits,
      legacyCostUsd: legacyCost,
      priceNow,
      valueUsd,
      pnlUsd,
      pnlPct,
      avgBuyPrice: v2Active ? v2Cost / pricedUnits : null,
      basis,
      stale,
      mismatch,
      valueKnown: true,
    });
  }

  rows.sort((a, b) => b.valueUsd - a.valueUsd || a.name.localeCompare(b.name));
  return rows;
}

export type PnlSummary = {
  /** Sum of row PnL. Null when no row has a market PnL — never a fake 0. */
  pnlUsd: number | null;
  /** pnlUsd / v2 cost of those rows, in percent. */
  pnlPct: number | null;
  /** v2 cost (costUsd − legacyCostUsd) of rows that have a PnL. */
  pricedCostUsd: number;
  /** Legacy cost of every row. Stays out of the PnL. */
  legacyCostUsd: number;
  hasLegacy: boolean;
  hasPriced: boolean;
  /** Cost of every row that has no market PnL (legacy and unpriced v2). */
  unpricedCostUsd: number;
  /** A v2 slice exists but Jupiter has no price, so its PnL was skipped. */
  hasUnpricedV2: boolean;
};

/** Portfolio PnL from rows `buildPositions` already produced. Does not revalue. */
export function pnlSummary(rows: PositionRow[]): PnlSummary {
  let pnlUsd = 0;
  let pricedCostUsd = 0;
  let legacyCostUsd = 0;
  let unpricedCostUsd = 0;
  let hasPriced = false;
  let hasUnpricedV2 = false;
  for (const row of rows) {
    if (Number.isFinite(row.legacyCostUsd)) legacyCostUsd += row.legacyCostUsd;
    if (row.pnlUsd == null || !Number.isFinite(row.pnlUsd)) {
      if (Number.isFinite(row.costUsd)) unpricedCostUsd += row.costUsd;
      if (row.pricedUnits > DUST) hasUnpricedV2 = true;
      continue;
    }
    hasPriced = true;
    pnlUsd += row.pnlUsd;
    const v2Cost = row.costUsd - row.legacyCostUsd;
    if (Number.isFinite(v2Cost)) pricedCostUsd += v2Cost;
  }
  return {
    pnlUsd: hasPriced ? pnlUsd : null,
    pnlPct: hasPriced && pricedCostUsd > DUST ? (pnlUsd / pricedCostUsd) * 100 : null,
    pricedCostUsd: hasPriced ? pricedCostUsd : 0,
    legacyCostUsd,
    hasLegacy: legacyCostUsd > DUST,
    hasPriced,
    unpricedCostUsd,
    hasUnpricedV2,
  };
}

/** Legacy cost basis shows an em dash. A v2 row with no price shows „brak danych”. */
export function positionPnlKind(
  row: Pick<PositionRow, "basis" | "pricedUnits" | "pnlUsd">,
): "legacy" | "nodata" | "value" {
  if (row.basis === "cost" && row.pricedUnits <= DUST) return "legacy";
  if (row.pnlUsd == null || !Number.isFinite(row.pnlUsd)) return "nodata";
  return "value";
}

export type RunPnlLeg = {
  name: string;
  valueUsd: number;
  pnlUsd: number;
  pnlPct: number | null;
};

export type RunPnlResult = {
  legs: Array<RunPnlLeg | null>;
  totalPnlUsd: number | null;
  totalPnlPct: number | null;
};

/**
 * PnL of one run against current Jupiter prices.
 * `slots === null` means no RunPrice account — the run stays unlabeled.
 * A leg with no current price is null and is left out of the total.
 */
export function runPnl(
  slots: Array<{ units: number; price: number } | null> | null,
  usdcEach: number[],
  quotes: Record<string, JupQuote>,
  names: string[],
): RunPnlResult | null {
  if (slots == null) return null;
  const n = Math.max(slots.length, usdcEach.length, names.length);
  const legs: Array<RunPnlLeg | null> = [];
  let totalPnl = 0;
  let totalCost = 0;
  let any = false;
  for (let i = 0; i < n; i++) {
    const slot = slots[i] ?? null;
    const name = names[i] ?? "";
    const usdc = usdcEach[i];
    const px = name ? quoteByName(quotes, name)?.usdPrice ?? null : null;
    if (!slot || px == null || !Number.isFinite(usdc)) {
      legs.push(null);
      continue;
    }
    const valueUsd = slot.units * px;
    const pnlUsd = valueUsd - usdc;
    legs.push({
      name,
      valueUsd,
      pnlUsd,
      pnlPct: usdc > DUST ? (pnlUsd / usdc) * 100 : null,
    });
    totalPnl += pnlUsd;
    totalCost += usdc;
    any = true;
  }
  return {
    legs,
    totalPnlUsd: any ? totalPnl : null,
    totalPnlPct: any && totalCost > DUST ? (totalPnl / totalCost) * 100 : null,
  };
}

export function portfolioValue(vaultUsdc: number, rows: PositionRow[]): number {
  const vault = Number.isFinite(vaultUsdc) ? vaultUsdc : 0;
  return rows.reduce((sum, row) => sum + (Number.isFinite(row.valueUsd) ? row.valueUsd : 0), vault);
}

/** Null when any row's buy price is unknown — never a silent $1 mark. */
export function portfolioUsdKnown(vaultUsdc: number, rows: PositionRow[]): number | null {
  if (rows.some((row) => row.valueKnown === false)) return null;
  return portfolioValue(vaultUsdc, rows);
}

export type PortfolioTileReason = "price" | "balances" | null;

/**
 * Whether the PreStock portfolio tile may show a dollar figure.
 * `priceUnknown` is a missing RunPrice (or `valueKnown === false`).
 * `balancesStale` is a soft token-balance miss (`balanceWarning`).
 * When both apply, `reason` is `"balances"`: the figure would be summed from
 * balances we failed to re-read, so the helper copy is the stale-balance
 * warning. The price-loading sentence stays a separate line (`priceUnknown`).
 */
export function portfolioTileState(input: {
  priceWarning?: string | null;
  balanceWarning?: string | null;
  positions: ReadonlyArray<{ valueKnown?: boolean }>;
}): {
  unknown: boolean;
  reason: PortfolioTileReason;
  priceUnknown: boolean;
  balancesStale: boolean;
} {
  const priceUnknown =
    Boolean(input.priceWarning) ||
    input.positions.some((row) => row.valueKnown === false);
  const balancesStale = Boolean(input.balanceWarning);
  const reason: PortfolioTileReason = balancesStale
    ? "balances"
    : priceUnknown
      ? "price"
      : null;
  return {
    unknown: priceUnknown || balancesStale,
    reason,
    priceUnknown,
    balancesStale,
  };
}

/**
 * Vault + marked positions, or null when the wallet is absent, a buy price
 * is still unknown, or token balances are the previous read.
 */
export function portfolioUsdForWallet(input: {
  hasOwner: boolean;
  priceWarning?: string | null;
  balanceWarning?: string | null;
  vaultUsdc: number | null;
  positions: PositionRow[];
}): number | null {
  if (!input.hasOwner || input.priceWarning || input.balanceWarning) return null;
  return portfolioUsdKnown(input.vaultUsdc ?? 0, input.positions);
}

/**
 * True when every lot is priced or legacy and each name's balance is at least
 * the sum of lot units (v2 units, or legacy cost at 1:1). Unknown lots fail.
 */
export function tokenBalancesCoverLots(lots: RunLot[], balances: TokenAmount[]): boolean {
  const expected = new Map<string, number>();
  for (const lot of lots) {
    if (lotState(lot) === "unknown") return false;
    const key = canonicalName(lot.name);
    const units = lot.units != null ? lot.units : lot.usdcCost;
    expected.set(key, (expected.get(key) ?? 0) + (Number.isFinite(units) ? units : 0));
  }
  for (const [name, exp] of expected) {
    if (!(exp > DUST)) continue;
    let bal = 0;
    for (const row of balances) {
      if (canonicalName(row.name) === name) bal += row.amount;
    }
    const scale = Math.max(Math.abs(exp), Math.abs(bal), 1);
    if (bal + DUST * scale < exp) return false;
  }
  return true;
}

/** Pie weights from USD value. Same remainder fix as the old unit weights. */
export function valueWeights(
  rows: Pick<PositionRow, "name" | "valueUsd">[],
): { name: string; value: number }[] {
  const nonzero = rows.filter((r) => r.valueUsd > 0);
  const total = nonzero.reduce((s, r) => s + r.valueUsd, 0);
  if (total <= 0) return [];
  const out = nonzero.map((r) => ({
    name: r.name,
    value: Math.round((r.valueUsd / total) * 1000) / 10,
  }));
  const sum = out.reduce((s, h) => s + h.value, 0);
  const rem = Math.round((100 - sum) * 10) / 10;
  if (rem !== 0 && out.length > 0) {
    let maxIdx = 0;
    for (let i = 1; i < out.length; i++) {
      if (out[i].value > out[maxIdx].value) maxIdx = i;
    }
    out[maxIdx] = {
      ...out[maxIdx],
      value: Math.round((out[maxIdx].value + rem) * 10) / 10,
    };
  }
  return out;
}
