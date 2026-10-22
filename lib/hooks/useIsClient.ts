"use client";

import { useSyncExternalStore } from "react";

function subscribe(): () => void {
  return () => {};
}

/** Client renders are mounted. The value never changes after hydration. */
function getSnapshot(): boolean {
  return true;
}

/**
 * Server render and the hydration render stay false, matching the old
 * `useState(false)` + effect. React then re-renders with the client snapshot.
 */
function getServerSnapshot(): boolean {
  return false;
}

/** True only after hydration, so wallet UI does not disagree with the server HTML. */
export function useIsClient(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
