/**
 * Per-read deadlines for refresh. web3.js 1.x and Anchor `fetch` /
 * `fetchNullable` do not take an AbortSignal, so each read is raced with a
 * timer. Do not put this timeout on the shared Connection: that same
 * Connection sends and confirms Privy/Phantom transactions.
 */

export const RPC_READ_TIMEOUT_MS = 15_000;

/** One refresh pass. Sequential reads share this, they do not each get 15s. */
export const RPC_REFRESH_BUDGET_MS = 20_000;

export class RpcTimeoutError extends Error {
  constructor(label?: string) {
    super(label ? `RPC read timed out: ${label}` : "RPC read timed out");
    this.name = "RpcTimeoutError";
  }
}

export function isRpcTimeout(err: unknown): boolean {
  if (err instanceof RpcTimeoutError) return true;
  return err instanceof Error && err.name === "RpcTimeoutError";
}

export function refreshDeadline(
  startMs: number,
  budgetMs = RPC_REFRESH_BUDGET_MS,
): number {
  return startMs + budgetMs;
}

/**
 * Timeout for the next read: at most `capMs`, and never past `deadlineMs`.
 * Zero means the refresh budget is already spent.
 */
export function readTimeoutMs(
  deadlineMs: number,
  nowMs = Date.now(),
  capMs = RPC_READ_TIMEOUT_MS,
): number {
  const left = deadlineMs - nowMs;
  if (!Number.isFinite(left) || left <= 0) return 0;
  const cap = Number.isFinite(capMs) && capMs > 0 ? capMs : 0;
  return Math.min(cap, left);
}

/**
 * Race `promise` with a timer. The timer is always cleared. A result that
 * arrives after the timeout is swallowed, including a late rejection, so it
 * cannot surface as an unhandled rejection. The original rejection still
 * propagates when it wins the race.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label?: string,
): Promise<T> {
  const limit = Number.isFinite(ms) && ms > 0 ? ms : 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new RpcTimeoutError(label));
    }, limit);
  });

  const guarded = promise.then(
    (value) => {
      if (settled) return undefined as T;
      settled = true;
      return value;
    },
    (err: unknown) => {
      if (settled) return undefined as T;
      settled = true;
      throw err;
    },
  );

  return Promise.race([guarded, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
