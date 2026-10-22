/**
 * Auto-buy copy about a low vault balance. Match the phrases we actually
 * show, not every sentence that mentions "vault" or "USDC".
 * 6002 is InsufficientVault (0x1772).
 */
const VAULT_LOW_REASON =
  /vault_low|insufficient\s+vault|insufficientvault|za mało\s+usdc|not enough\s+usdc|niewystarczające saldo w vault|not enough balance in the vault|error number:\s*6002|custom program error:\s*0x1772|\b0x1772\b|\b6002\b/i;

export function isVaultLowReason(reason: string): boolean {
  return VAULT_LOW_REASON.test(reason);
}
