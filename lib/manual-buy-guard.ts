import { shown, translate } from "@/lib/i18n";
import { isUnconfirmedTimeout } from "./vault-follow-up";

/** Polish sentence. A throw uses the language active at that moment. */
export const BUY_ALREADY_IN_FLIGHT_MSG = translate("pl", "tx.err.buyInFlight");

/** Mutable flag. A ref `{ current: boolean }` satisfies this. */
export type ManualBuyGate = { current: boolean };

/**
 * Synchronous Manual Buy gate. React `txPending` flips only after await,
 * so a second click must be rejected before the first paint.
 * Returns false when a buy is already held or another tx is pending.
 */
export function tryEnterManualBuy(gate: ManualBuyGate, txPending: boolean): boolean {
  if (gate.current || txPending) return false;
  gate.current = true;
  return true;
}

export function leaveManualBuy(gate: ManualBuyGate): void {
  gate.current = false;
}

/**
 * A Kup confirm-timeout may already have created this RunRecord.
 * Remember the index so a later RunAlreadyExists does not buy the next one.
 * Other errors leave the set alone (a keeper collision can still retry once).
 */
export function noteUnconfirmedRunIndex(
  createdRunIndices: Set<number>,
  runIndex: number,
  err: unknown,
): void {
  if (!isUnconfirmedTimeout(err)) return;
  createdRunIndices.add(runIndex);
}

/**
 * Retry RunAlreadyExists only when this card did not create `failedIndex`.
 * A keeper (or anyone else) may take the index: then one next-index retry is ok.
 * An index in `createdRunIndices` was created here: do not buy the next one.
 */
export function shouldRetryRunIndex(
  createdRunIndices: ReadonlySet<number>,
  failedIndex: number,
): boolean {
  return !createdRunIndices.has(failedIndex);
}

/**
 * After RunAlreadyExists on `failedIndex`: submit the next free index once,
 * only when `shouldRetryRunIndex` allows it. Does not call `submitOnce` on stop.
 */
export async function recoverRunCollision(args: {
  failedIndex: number;
  createdRunIndices: ReadonlySet<number>;
  findNextIndex: () => Promise<number | null>;
  submitOnce: (index: number) => Promise<string>;
}): Promise<string> {
  if (!shouldRetryRunIndex(args.createdRunIndices, args.failedIndex)) {
    throw new Error(shown("tx.err.buyInFlight"));
  }
  const retryIndex = await args.findNextIndex();
  if (retryIndex == null || retryIndex === args.failedIndex) {
    throw new Error(shown("auto.error.predca.6004"));
  }
  return args.submitOnce(retryIndex);
}
