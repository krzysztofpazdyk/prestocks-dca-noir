import { translate } from "@/lib/i18n";
import type { Locale } from "@/lib/locale-store";
import { isStaleBlockhashError } from "@/lib/privy-blockhash";

/** Title on Privy's post-sign screen. Replaces "Transaction signed!". */
export const PRIVY_SIGN_SUCCESS_HEADER_KEY = "privy.signSuccessHeader";
/** Body on that screen. Replaces "You're all set." */
export const PRIVY_SIGN_SUCCESS_DESCRIPTION_KEY = "privy.signSuccessDescription";
/** In-app line while Privy's sign promise is still pending. */
export const PRIVY_SIGN_WAIT_KEY = "privy.signWait";
/** Shown after a stale-blockhash send failure on a Privy wallet. */
export const PRIVY_BLOCKHASH_EXPIRED_KEY = "privy.blockhashExpired";

export type PrivySignSuccessUi = {
  successHeader: string;
  successDescription: string;
};

/**
 * Copy for the screen Privy shows after Approve and before Close.
 * Only `successHeader` and `successDescription`. No `showWalletUIs`:
 * that flag would also hide the confirmation screen.
 */
export function privySignSuccessUi(locale: Locale): PrivySignSuccessUi {
  return {
    successHeader: translate(locale, PRIVY_SIGN_SUCCESS_HEADER_KEY),
    successDescription: translate(locale, PRIVY_SIGN_SUCCESS_DESCRIPTION_KEY),
  };
}

/**
 * Plain message when Privy signed but the blockhash died before send.
 * Null for every other error, and for Phantom, so the caller keeps its
 * existing text. Does not decide whether to retry.
 */
export function privySendFailureMessage(
  error: unknown,
  locale: Locale,
  isPrivy: boolean,
): string | null {
  if (!isPrivy || !isStaleBlockhashError(error)) return null;
  return translate(locale, PRIVY_BLOCKHASH_EXPIRED_KEY);
}

let signingCount = 0;
const signingListeners = new Set<() => void>();

function emitPrivySigning(): void {
  for (const listener of signingListeners) listener();
}

/** One Privy `signTransaction` call started. Nested signs stay visible. */
export function beginPrivySign(): void {
  signingCount += 1;
  if (signingCount === 1) emitPrivySigning();
}

/** The matching sign call finished, succeeded, or threw. */
export function endPrivySign(): void {
  if (signingCount === 0) return;
  signingCount -= 1;
  if (signingCount === 0) emitPrivySigning();
}

export function subscribePrivySigning(listener: () => void): () => void {
  signingListeners.add(listener);
  return () => {
    signingListeners.delete(listener);
  };
}

export function getPrivySigningSnapshot(): boolean {
  return signingCount > 0;
}

export function getPrivySigningServerSnapshot(): boolean {
  return false;
}
