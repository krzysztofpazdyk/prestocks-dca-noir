"use client";

import { useEffect, useLayoutEffect, useRef } from "react";

/**
 * Static export renders on the server, where useLayoutEffect warns and does
 * not run. The browser copy is useLayoutEffect, so the ref is current before
 * passive effects and events. Server and client are separate bundles.
 */
export const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

/** Copy the latest value. Call this from a layout effect, not during render. */
export function commitLatestRef<T>(ref: { current: T }, value: T): void {
  ref.current = value;
}

/**
 * Ref that starts as the first render's value and then follows `value`.
 * The copy runs after render, before useEffect in this component, so an
 * async call still sees the newest render and not a stale closure.
 * Wallet components inline this instead of calling it: exhaustive-deps
 * does not treat a ref returned from a custom hook as a ref.
 */
export function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  useIsomorphicLayoutEffect(() => {
    commitLatestRef(ref, value);
  });
  return ref;
}
