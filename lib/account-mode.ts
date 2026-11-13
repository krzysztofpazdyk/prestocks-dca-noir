/**
 * Program errors that mean "the account is still 59 bytes and the program
 * is already upgraded". Those are a quiet updating state, not a red error.
 */

export const ERR_RUN_INDEX_MISMATCH = 6019;
export const ERR_USER_NOT_MIGRATED = 6020;
export const ERR_INSTRUCTION_DEPRECATED = 6022;
export const ERR_VAULT_NOT_EMPTY = 6023;
/** Anchor AccountDidNotDeserialize. deposit/withdraw/budget on a 59-byte account. */
export const ERR_ACCOUNT_DID_NOT_DESERIALIZE = 3003;

const UPDATING_CODES = new Set([
  ERR_USER_NOT_MIGRATED,
  ERR_INSTRUCTION_DEPRECATED,
  ERR_ACCOUNT_DID_NOT_DESERIALIZE,
]);

function errorBlob(err: unknown): string {
  if (err == null) return "";
  const e = err as { message?: string; logs?: string[] };
  const logs = Array.isArray(e.logs) ? e.logs.join("\n") : "";
  return `${e.message ?? ""}\n${logs}\n${String(err)}`;
}

/** Anchor custom error number, from the typed error or from logs. */
export function programErrorNumber(err: unknown): number | null {
  if (err == null || typeof err !== "object") {
    const text = errorBlob(err);
    return numberFromText(text);
  }
  const e = err as {
    error?: { errorCode?: { number?: number; code?: string } };
    code?: number;
  };
  const typed = e.error?.errorCode?.number;
  if (typeof typed === "number" && Number.isFinite(typed)) return typed;
  if (typeof e.code === "number" && Number.isFinite(e.code)) return e.code;
  const name = e.error?.errorCode?.code;
  if (name === "AccountDidNotDeserialize") return ERR_ACCOUNT_DID_NOT_DESERIALIZE;
  if (name === "RunIndexMismatch") return ERR_RUN_INDEX_MISMATCH;
  if (name === "UserNotMigrated") return ERR_USER_NOT_MIGRATED;
  if (name === "InstructionDeprecated") return ERR_INSTRUCTION_DEPRECATED;
  if (name === "VaultNotEmpty") return ERR_VAULT_NOT_EMPTY;
  return numberFromText(errorBlob(err));
}

function numberFromText(text: string): number | null {
  const numbered = text.match(/Error Number:\s*(\d+)/i);
  if (numbered) return Number(numbered[1]);
  if (/AccountDidNotDeserialize/i.test(text)) return ERR_ACCOUNT_DID_NOT_DESERIALIZE;
  if (/RunIndexMismatch/i.test(text)) return ERR_RUN_INDEX_MISMATCH;
  if (/UserNotMigrated/i.test(text)) return ERR_USER_NOT_MIGRATED;
  if (/InstructionDeprecated/i.test(text)) return ERR_INSTRUCTION_DEPRECATED;
  if (/VaultNotEmpty/i.test(text)) return ERR_VAULT_NOT_EMPTY;
  const hex = text.match(/custom program error:\s*0x([0-9a-f]+)/i);
  if (hex) return Number.parseInt(hex[1], 16);
  return null;
}

export function isRunIndexMismatch(err: unknown): boolean {
  return programErrorNumber(err) === ERR_RUN_INDEX_MISMATCH;
}

export function isVaultNotEmpty(err: unknown): boolean {
  return programErrorNumber(err) === ERR_VAULT_NOT_EMPTY;
}

/**
 * True only for a 59-byte account. 6020, 6022, and Anchor 3003 then mean the
 * program is upgraded and this account is waiting. Never a red error.
 */
export function isAccountUpdatingError(err: unknown, legacyAccount: boolean): boolean {
  if (!legacyAccount) return false;
  const code = programErrorNumber(err);
  return code != null && UPDATING_CODES.has(code);
}

/** How often to re-read while the account is waiting. One read, no extra RPC. */
export const ACCOUNT_UPDATE_POLL_MS = 60_000;

export type DeferKind = "updating" | "queued" | null;

/**
 * `user_not_migrated` is the same quiet banner as a 59-byte 6020.
 * `owner_ata_missing` is the existing neutral "purchase queued" line.
 * Any other deferred phase stays queued, as it does today.
 */
export function classifyDefer(status: {
  phase?: string | null;
  deferReason?: string | null;
  error?: string | null;
}): DeferKind {
  const reason = (status.deferReason ?? "").trim();
  if (reason === "user_not_migrated") return "updating";
  if (reason === "owner_ata_missing") return "queued";
  if (status.phase === "deferred") return "queued";
  const err = status.error ?? "";
  if (
    status.phase === "error" &&
    /deferred|ops_pending|insufficient lamports|not enough sol|keeper ma za mało sol/i.test(
      err,
    )
  ) {
    return "queued";
  }
  return null;
}
