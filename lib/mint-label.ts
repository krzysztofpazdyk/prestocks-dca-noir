import type { PublicKey } from "@solana/web3.js";
import { nameByMint } from "@/lib/devnet-mock-mints";
import { shortPk } from "@/lib/predca";

/**
 * Company name for a known devnet mint.
 * Unknown mints keep a short address (`n` characters on each side).
 */
export function mintLabel(mint: PublicKey | string, n = 4): string {
  return nameByMint(mint) ?? shortPk(mint, n);
}
