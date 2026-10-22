/**
 * Wallet-picker open/close decisions. These match the old effects:
 * a new error opens the list, and a settled connection closes it.
 * The caller remembers the previous snapshot so a manual open is left
 * alone until the connection state actually changes.
 */

export function pickerShouldOpenForError(
  error: string | null,
  seenError: string | null,
): boolean {
  return Boolean(error) && seenError !== error;
}

export type SettleSnapshot = {
  busy: boolean;
  dropped: boolean;
  staleHold: boolean;
  connected: boolean;
  hasPublicKey: boolean;
  pinnedAddress: string | null;
  error: string | null;
  /** Same identity comparison as the effect dependency on job.publicKey. */
  publicKey: unknown;
};

export function settleDepsChanged(
  prev: SettleSnapshot | null,
  next: SettleSnapshot,
): boolean {
  if (prev == null) return true;
  return (
    prev.busy !== next.busy ||
    prev.dropped !== next.dropped ||
    prev.staleHold !== next.staleHold ||
    prev.connected !== next.connected ||
    prev.hasPublicKey !== next.hasPublicKey ||
    prev.pinnedAddress !== next.pinnedAddress ||
    prev.error !== next.error ||
    prev.publicKey !== next.publicKey
  );
}

export function connectionSettled(next: SettleSnapshot): boolean {
  return (
    !next.dropped &&
    !next.staleHold &&
    ((next.connected && next.hasPublicKey) || Boolean(next.pinnedAddress))
  );
}

export function pickerShouldClose(
  next: SettleSnapshot,
  depsChanged: boolean,
): boolean {
  return depsChanged && !next.busy && connectionSettled(next) && !next.error;
}
