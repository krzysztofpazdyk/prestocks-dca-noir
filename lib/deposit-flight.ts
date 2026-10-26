/**
 * A deposit click lives only until the transaction settles.
 * sessionStorage survives a reload, so a leftover flight is cleared and
 * reported instead of leaving the button disabled.
 */

export const DEPOSIT_FLIGHT_KEY = "noir3.depositFlight.v1";

export type DepositFlight = {
  amountUsd: number;
  startedAtMs: number;
};

export type DepositStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

function isFlight(value: unknown): value is DepositFlight {
  if (!value || typeof value !== "object") return false;
  const row = value as DepositFlight;
  return (
    typeof row.amountUsd === "number" &&
    Number.isFinite(row.amountUsd) &&
    row.amountUsd > 0 &&
    typeof row.startedAtMs === "number" &&
    Number.isFinite(row.startedAtMs)
  );
}

export function readDepositFlight(
  storage: DepositStorage,
  nowMs: number,
): DepositFlight | null {
  if (!Number.isFinite(nowMs)) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(DEPOSIT_FLIGHT_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isFlight(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeDepositFlight(storage: DepositStorage, flight: DepositFlight): void {
  try {
    storage.setItem(DEPOSIT_FLIGHT_KEY, JSON.stringify(flight));
  } catch {
    /* private mode still sends the deposit */
  }
}

export function clearDepositFlight(storage: DepositStorage): void {
  try {
    storage.removeItem(DEPOSIT_FLIGHT_KEY);
  } catch {
    /* private mode */
  }
}

/**
 * Reload dropped the in-memory click. Drop the stored flight too, so Deposit
 * is not left disabled, and let the caller show what happened.
 */
export function takeInterruptedDeposit(
  storage: DepositStorage,
  nowMs: number,
): DepositFlight | null {
  const flight = readDepositFlight(storage, nowMs);
  clearDepositFlight(storage);
  return flight;
}

export function depositFlightStorage(): DepositStorage | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    return sessionStorage;
  } catch {
    return null;
  }
}
