import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import {
  AccountLayout,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import idl from "@/idl/predca.json";
import type { Predca } from "@/types/predca";
import {
  isRpcTimeout,
  readTimeoutMs,
  RPC_READ_TIMEOUT_MS,
  withTimeout,
} from "@/lib/rpc-timeout";
import { shown, translate } from "@/lib/i18n";
import { formatDollars } from "@/lib/number-format";
import { textKeepingSignature } from "@/lib/vault-follow-up";

export const DEFAULT_PROGRAM_ID =
  "Eb3TFLeYi3dHZwoKCBvvUpx3gMnP2XdmMXX3rstUpdwC";

export const USDC_DECIMALS = 6;
export const USDC_FACTOR = 1_000_000;

/** Devnet mock USDC mint used by predca 3.0 (see .env.production). */
export const MOCK_USDC_MINT =
  "3xtTBfHRf8AKEmhbFYqRoXfi9RaxxiqG9YfifjCjD4qm";

const PREDCA_ERROR_CODES = [
  6000, 6001, 6002, 6003, 6004, 6005, 6006, 6007,
  6008, 6009, 6010, 6011, 6012, 6013, 6014, 6015,
] as const;

/** Polish program sentences. Values come from i18n so the wording stays one place. */
export const PREDCA_ERROR_PL: Record<number, string> = Object.fromEntries(
  PREDCA_ERROR_CODES.map((code) => [code, translate("pl", `auto.error.predca.${code}`)]),
);

function predcaErrorText(code: number): string | null {
  if (!PREDCA_ERROR_PL[code]) return null;
  return shown(`auto.error.predca.${code}`);
}

export function programId(): PublicKey {
  const raw =
    process.env.NEXT_PUBLIC_PREDCA_PROGRAM_ID?.trim() || DEFAULT_PROGRAM_ID;
  return new PublicKey(raw);
}

/** Localnet mock mint — set after creating mint on validator. Empty = not configured. */
export function usdcMintOrNull(): PublicKey | null {
  const raw = process.env.NEXT_PUBLIC_USDC_MINT?.trim();
  if (!raw) return null;
  try {
    return new PublicKey(raw);
  } catch {
    return null;
  }
}

/** Public Solana Devnet RPC (no API key). Helius needs ?api-key= and returns 401 without it. */
export const PUBLIC_DEVNET_RPC = "https://api.devnet.solana.com";
export const HELIUS_DEVNET_RPC = "https://devnet.helius-rpc.com";

/**
 * Resolve RPC endpoint.
 * Prefer NEXT_PUBLIC_RPC_URL; production/Pages never falls back to localnet.
 * Local `next dev` may use 127.0.0.1:8899 when no env is set.
 */
export function rpcUrl(): string {
  const fromEnv =
    process.env.NEXT_PUBLIC_RPC_URL?.trim() ||
    process.env.NEXT_PUBLIC_SOLANA_RPC?.trim();
  if (fromEnv) return fromEnv;

  // Production / static Pages build: never fall back to localnet.
  // Prefer public api.devnet (Helius without api-key returns 401).
  if (process.env.NODE_ENV === "production") {
    return PUBLIC_DEVNET_RPC;
  }

  // Local `next dev` with no env → localnet OK
  return "http://127.0.0.1:8899";
}

/** Hostname only (for UI strip) — never the full URL with secrets/query. */
export function rpcHost(): string {
  try {
    return new URL(rpcUrl()).hostname;
  } catch {
    return "unknown";
  }
}

export type ClusterLabel = "DEVNET" | "LOCALNET" | "MAINNET" | "CUSTOM";

export function clusterLabel(): ClusterLabel {
  const rpc = rpcUrl().toLowerCase();
  if (rpc.includes("devnet")) return "DEVNET";
  if (rpc.includes("mainnet")) return "MAINNET";
  if (rpc.includes("127.0.0.1:8899") || rpc.includes("localhost:8899")) {
    return "LOCALNET";
  }
  return "CUSTOM";
}

export function clusterShortPl(): string {
  switch (clusterLabel()) {
    case "DEVNET":
      return "Devnet";
    case "LOCALNET":
      return "Localnet";
    case "MAINNET":
      return "Mainnet";
    default:
      return "Custom";
  }
}

function explorerQuery(): string {
  if (rpcUrl().toLowerCase().includes("devnet")) {
    return "?cluster=devnet";
  }
  return "?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899";
}

export function explorerTxUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}${explorerQuery()}`;
}

export function explorerAddressUrl(address: PublicKey | string): string {
  const value = typeof address === "string" ? address : address.toBase58();
  return `https://explorer.solana.com/address/${value}${explorerQuery()}`;
}

export function userConfigPda(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("user"), owner.toBuffer()],
    programId(),
  );
}

export function vaultPda(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), owner.toBuffer()],
    programId(),
  );
}

/** Global mint authority PDA for mock PreStock mints. */
export function mintAuthPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("mint_auth")],
    programId(),
  );
}

export function runRecordPda(
  owner: PublicKey,
  runIndex: number | BN,
): [PublicKey, number] {
  const idx = BN.isBN(runIndex) ? runIndex : new BN(runIndex);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("run"), owner.toBuffer(), idx.toArrayLike(Buffer, "le", 8)],
    programId(),
  );
}

/** PriceFeed PDA. Seeds [b"price", mint]. Pass it explicitly — the IDL does not derive it. */
export function priceFeedPda(
  mint: PublicKey,
  program: PublicKey = programId(),
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("price"), mint.toBuffer()],
    program,
  );
}

/**
 * RunPrice PDA. Seeds [b"run_price", owner, run_index u64 LE].
 * The program creates the account. Callers must pass it explicitly.
 */
export function runPricePda(
  owner: PublicKey,
  runIndex: number | BN,
  program: PublicKey = programId(),
): [PublicKey, number] {
  const idx = BN.isBN(runIndex) ? runIndex : new BN(runIndex);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("run_price"), owner.toBuffer(), idx.toArrayLike(Buffer, "le", 8)],
    program,
  );
}

export function getProgram(provider: AnchorProvider): Program<Predca> {
  const idlWithAddress = {
    ...idl,
    address: programId().toBase58(),
  };
  return new Program(idlWithAddress as Predca, provider);
}

export function dollarsToRaw(dollars: number): BN {
  if (!Number.isFinite(dollars) || dollars < 0) {
    throw new Error(shown("tx.err.invalidAmount"));
  }
  return new BN(Math.round(dollars * USDC_FACTOR));
}

export function rawToDollars(raw: BN | number | string | bigint): number {
  const n = typeof raw === "object" && raw !== null && "toNumber" in raw
    ? (raw as BN).toNumber()
    : Number(raw);
  return n / USDC_FACTOR;
}

export function formatUsd(amount: number, digits = 2): string {
  return formatDollars(amount, digits);
}

export function ownerUsdcAta(owner: PublicKey, mint: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID);
}

export type UserConfigData = {
  owner: PublicKey;
  weeklyBudgetUsdc: BN;
  excludeFlags: number;
  lastRunTs: BN;
  bump: number;
  vaultBump: number;
};

export type RunRecordData = {
  mints: PublicKey[];
  amounts: BN[];
  signatureHash: number[];
  slot: BN;
  ts: BN;
  runIndex: BN;
  owner: PublicKey;
  bump: number;
};

const MISSING_ACCOUNT_RE =
  /could not find account|Account does not exist|has no data|Invalid param: could not find/i;

/** True only for a missing account. RPC and rate-limit failures stay false. */
export function isMissingAccountError(e: unknown): boolean {
  const message =
    e instanceof Error
      ? e.message
      : e && typeof e === "object" && "message" in e
        ? String((e as { message?: unknown }).message ?? "")
        : "";
  return MISSING_ACCOUNT_RE.test(`${message}\n${String(e)}`);
}

/** status / statusCode on the error or on error.response. */
export function httpStatusCode(err: unknown): number | null {
  if (err == null || typeof err !== "object") return null;
  const e = err as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown; statusCode?: unknown };
  };
  const values = [e.status, e.statusCode, e.response?.status, e.response?.statusCode];
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  }
  return null;
}

function errorMessageText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message?: unknown }).message ?? "");
  }
  return String(err ?? "");
}

/**
 * Transport and rate-limit failures. `\b429\b` does not match a digit run
 * buried inside a signature. An object with status 429 counts even if the
 * message never says 429. `RpcTimeoutError` counts: a hung read is a soft miss.
 */
export function isRateOrNetworkError(err: unknown): boolean {
  if (isRpcTimeout(err)) return true;
  if (httpStatusCode(err) === 429) return true;
  const msg = errorMessageText(err);
  if (/\b429\b/.test(msg) || /\b50[234]\b/.test(msg)) return true;
  return /failed to fetch|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|Network request failed|fetch failed|too many requests|rate limit/i.test(
    msg,
  );
}

export function isRpcDisconnect(err: unknown, msg: string): boolean {
  if (isRpcTimeout(err) || httpStatusCode(err) === 429) return true;
  return (
    /failed to fetch|ECONNREFUSED|Network request failed|fetch failed/i.test(msg) ||
    /\b429\b/.test(msg)
  );
}

export async function fetchUserConfig(
  program: Program<Predca>,
  owner: PublicKey,
  timeoutMs?: number,
): Promise<UserConfigData | null> {
  const [pda] = userConfigPda(owner);
  const pending = program.account.userConfig.fetchNullable(pda);
  const acc =
    timeoutMs == null
      ? await pending
      : await withTimeout(pending, timeoutMs, "userConfig");
  if (!acc) return null;
  return acc as unknown as UserConfigData;
}

export async function fetchVaultBalance(
  connection: Connection,
  owner: PublicKey,
): Promise<number | null> {
  const [vault] = vaultPda(owner);
  try {
    const bal = await connection.getTokenAccountBalance(vault);
    return Number(bal.value.uiAmountString ?? bal.value.uiAmount ?? 0);
  } catch (e) {
    if (isMissingAccountError(e)) return null;
    throw e;
  }
}

/**
 * Fresh vault balance wins. The on-screen number is used only when that one
 * read fails with a rate limit or a dropped connection. Any other read error
 * is rethrown, and a missing account (fresh null, no error) stays null.
 */
export function resolveVaultBalanceForBuy(
  fresh: number | null,
  screen: number | null,
  readError: unknown | null,
): number | null {
  if (readError == null) return fresh;
  if (isRateOrNetworkError(readError) && screen != null) return screen;
  throw readError;
}

/** Vault read that never throws. A failed read is "unknown", not zero. */
export async function readVaultOrNull(
  connection: Connection,
  owner: PublicKey,
): Promise<number | null> {
  try {
    return await fetchVaultBalance(connection, owner);
  } catch {
    return null;
  }
}

/** Owner ATA balance for the configured mock USDC mint (null if ATA missing). */
export async function fetchOwnerUsdcBalance(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey,
): Promise<number | null> {
  const ata = ownerUsdcAta(owner, mint);
  try {
    const bal = await connection.getTokenAccountBalance(ata);
    return Number(bal.value.uiAmountString ?? bal.value.uiAmount ?? 0);
  } catch (e) {
    if (isMissingAccountError(e)) return null;
    throw e;
  }
}

/**
 * How many contiguous run indices to probe (0 .. cap-1).
 * UserConfig stores last_run_ts and has no run counter, so the next index is
 * the first empty run PDA. Weekly buys stay far below this; the scan stops
 * at the first gap instead of always walking the cap.
 */
export const RUN_RECORD_SCAN_CAP = 1024;
const RUN_RECORD_BATCH = 100;

/** Polish sentence kept for equality checks and messages saved earlier. */
export const RUN_INDEX_TAKEN_MSG = translate("pl", "auto.error.predca.6004");

/** Run-index collision copy in Polish, English, or the sentence saved earlier. */
export function isRunIndexTakenMessage(text: string): boolean {
  const raw = text.trim();
  return raw === RUN_INDEX_TAKEN_MSG || raw === translate("en", "auto.error.predca.6004");
}

/** Index of the first null slot. `start` is the on-chain index of slots[0]. */
export function firstFreeRunIndex(
  slots: ReadonlyArray<unknown>,
  start = 0,
): number | null {
  for (let i = 0; i < slots.length; i++) {
    if (slots[i] == null) return start + i;
  }
  return null;
}

export function isRunAlreadyExists(err: unknown): boolean {
  if (err == null) return false;
  const e = err as {
    error?: { errorCode?: { number?: number; code?: string } };
    message?: string;
    logs?: string[];
  };
  const code = e.error?.errorCode;
  if (code?.number === 6004 || code?.code === "RunAlreadyExists") return true;
  const blob = `${e.message ?? ""}\n${Array.isArray(e.logs) ? e.logs.join("\n") : ""}\n${String(err)}`;
  return /RunAlreadyExists|RunRecord already exists|Error Number: 6004|custom program error: 0x1774|already in use/i.test(
    blob,
  );
}

export type RunRecordScan = {
  records: RunRecordData[];
  /** First missing PDA, or null when every index below the cap is occupied. */
  nextIndex: number | null;
};

/**
 * Load RunRecords for owner by scanning PDA indices in batches.
 * Stops at the first missing account (simulate_buy_v2 / execute_buy_v2 use the
 * next free index). `scanCap` is an exclusive upper bound, not an inclusive
 * last index.
 */
export async function scanRunRecords(
  program: Program<Predca>,
  owner: PublicKey,
  scanCap = RUN_RECORD_SCAN_CAP,
): Promise<RunRecordScan> {
  const records: RunRecordData[] = [];
  const cap = Math.max(0, Math.floor(scanCap));
  for (let start = 0; start < cap; start += RUN_RECORD_BATCH) {
    const count = Math.min(RUN_RECORD_BATCH, cap - start);
    const pdas: PublicKey[] = [];
    for (let i = 0; i < count; i++) {
      pdas.push(runRecordPda(owner, start + i)[0]);
    }
    const found = await program.account.runRecord.fetchMultiple(pdas);
    const freeAt = firstFreeRunIndex(found, start);
    const occupied =
      freeAt == null ? found.length : Math.max(0, freeAt - start);
    for (let j = 0; j < occupied; j++) {
      const acc = found[j];
      if (acc != null) records.push(acc as unknown as RunRecordData);
    }
    if (freeAt != null) return { records, nextIndex: freeAt };
  }
  return { records, nextIndex: null };
}

export async function fetchRunRecords(
  program: Program<Predca>,
  owner: PublicKey,
  scanCap = RUN_RECORD_SCAN_CAP,
): Promise<RunRecordData[]> {
  const { records } = await scanRunRecords(program, owner, scanCap);
  return records;
}

/** Next free run PDA index, read on-chain. Null when the scan cap is full. */
export async function findNextRunIndex(
  program: Program<Predca>,
  owner: PublicKey,
  scanCap = RUN_RECORD_SCAN_CAP,
): Promise<number | null> {
  const { nextIndex } = await scanRunRecords(program, owner, scanCap);
  return nextIndex;
}

export function shortPk(pk: PublicKey | string, n = 4): string {
  const s = typeof pk === "string" ? pk : pk.toBase58();
  if (s.length <= n * 2 + 1) return s;
  return `${s.slice(0, n)}…${s.slice(-n)}`;
}

export function formatTs(ts: BN | number): string {
  const sec = typeof ts === "object" && ts !== null && "toNumber" in ts
    ? (ts as BN).toNumber()
    : Number(ts);
  if (!sec || sec <= 0) return "—";
  try {
    return new Date(sec * 1000).toLocaleString("pl-PL", {
      timeZone: "Europe/Warsaw",
    });
  } catch {
    return String(sec);
  }
}

export function parseAnchorError(err: unknown): string {
  if (err == null) return shown("tx.err.unknown");
  const e = err as {
    error?: { errorCode?: { number?: number; code?: string }; errorMessage?: string };
    message?: string;
    logs?: string[];
  };

  const code = e.error?.errorCode?.number;
  if (code != null) {
    const text = predcaErrorText(code);
    if (text) return text;
  }
  if (e.error?.errorMessage) {
    const em = e.error.errorMessage;
    if (/RunRecord already exists|RunAlreadyExists/i.test(em)) {
      return shown("auto.error.predca.6004");
    }
    const mapped = mapCommonSolanaError(em);
    if (mapped) return mapped;
    return em;
  }

  const logs = Array.isArray(e.logs) ? e.logs.join("\n") : "";
  const msg = `${e.message ?? String(err)}\n${logs}`;

  const mapped = mapCommonSolanaError(msg);
  if (mapped) return mapped;

  const m = msg.match(/Error Code: (\w+)\. Error Number: (\d+)/);
  if (m) {
    const num = Number(m[2]);
    const text = predcaErrorText(num);
    if (text) return text;
    return `${m[1]} (${m[2]})`;
  }
  if (/User rejected|rejected the request/i.test(msg)) {
    return shown("tx.err.walletRejected");
  }
  if (isRpcDisconnect(err, msg)) {
    const raw = (e.message ?? String(err)).trim().slice(0, 120);
    return shown("tx.err.rpcDown", { detail: raw ? ` [${raw}]` : "" });
  }
  const trimmed = (e.message ?? String(err)).trim();
  if (isRunIndexTakenMessage(trimmed)) return shown("auto.error.predca.6004");
  if (
    trimmed === translate("pl", "tx.err.buyInFlight") ||
    trimmed === translate("en", "tx.err.buyInFlight")
  ) {
    return shown("tx.err.buyInFlight");
  }
  return textKeepingSignature(trimmed);
}

function mapCommonSolanaError(msg: string): string | null {
  const mintHint = usdcMintOrNull()?.toBase58() ?? MOCK_USDC_MINT;
  if (
    /insufficient funds|insufficient lamports|Error: Insufficient/i.test(msg) ||
    /Transfer: insufficient/i.test(msg)
  ) {
    return shown("tx.err.insufficientMock", { mint: mintHint });
  }
  if (
    /could not find account|AccountNotFound|Account does not exist|InvalidAccountData|account not found/i.test(
      msg,
    ) ||
    /failed to get account info|AccountOwnedByWrongProgram/i.test(msg)
  ) {
    return shown("tx.err.missingAta", { mint: mintHint });
  }
  if (/Simulation failed/i.test(msg) && /custom program error: 0x1\b/i.test(msg)) {
    return shown("tx.err.lowWalletUsdc", { mint: mintHint });
  }
  return null;
}


/** Lamports → SOL. */
export async function fetchSolBalance(
  connection: Connection,
  owner: PublicKey,
): Promise<number | null> {
  const lamports = await connection.getBalance(owner);
  return lamports / 1_000_000_000;
}

export type MockTokenBalance = {
  name: string;
  mint: PublicKey;
  /** Human amount (raw / 1e6). Token count, not a market value. */
  amount: number;
  raw: bigint;
};

/** One getMultipleAccountsInfo batch. Devnet mock set is 8; cap is 100. */
export const TOKEN_BALANCE_BATCH = 100;

export type TokenBalanceRead = {
  balances: MockTokenBalance[];
  /** `unknown` keeps the previous balances. `error` may become rpcError. */
  status: "ok" | "unknown" | "error";
  /** i18n key when unknown; raw message when error. */
  detail: string | null;
};

/** SPL token amount at byte 64. Null when the account cannot be decoded. */
export function rawTokenAmount(data: Uint8Array): bigint | null {
  try {
    if (data.byteLength < AccountLayout.span) return null;
    const decoded = AccountLayout.decode(
      Buffer.from(data.buffer, data.byteOffset, data.byteLength),
    );
    const amount = decoded.amount;
    if (typeof amount === "bigint") return amount;
    if (typeof amount === "number" && Number.isFinite(amount)) return BigInt(Math.trunc(amount));
    return null;
  } catch {
    return null;
  }
}

/**
 * Read owner ATAs for all Devnet mock PreStock mints in batches of 100.
 * Missing account → 0. A 429/network failure or one undecodable account
 * returns `unknown` instead of throwing the whole refresh away.
 */
export async function fetchMockTokenBalances(
  connection: Connection,
  owner: PublicKey,
  entries: { name: string; mint: PublicKey }[],
  opts?: { timeoutMs?: number },
): Promise<TokenBalanceRead> {
  const rows: MockTokenBalance[] = [];
  const atas = entries.map(({ name, mint }) => ({
    name,
    mint,
    ata: getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID),
  }));
  const budget = opts?.timeoutMs ?? RPC_READ_TIMEOUT_MS;
  const deadline = Date.now() + budget;
  try {
    for (let i = 0; i < atas.length; i += TOKEN_BALANCE_BATCH) {
      const slice = atas.slice(i, i + TOKEN_BALANCE_BATCH);
      const infos = await withTimeout(
        connection.getMultipleAccountsInfo(slice.map((row) => row.ata)),
        readTimeoutMs(deadline),
        "getMultipleAccountsInfo",
      );
      if (infos.length !== slice.length) {
        return { balances: [], status: "unknown", detail: "balances.warning" };
      }
      for (let j = 0; j < slice.length; j++) {
        const info = infos[j];
        const { name, mint } = slice[j];
        if (!info) {
          rows.push({ name, mint, amount: 0, raw: BigInt(0) });
          continue;
        }
        const raw = rawTokenAmount(info.data);
        if (raw == null) {
          return { balances: [], status: "unknown", detail: "balances.warning" };
        }
        const amount = Number(raw) / 1e6;
        rows.push({
          name,
          mint,
          amount: Number.isFinite(amount) ? amount : 0,
          raw,
        });
      }
    }
  } catch (e) {
    if (isRateOrNetworkError(e)) {
      return { balances: [], status: "unknown", detail: "balances.warning" };
    }
    return {
      balances: [],
      status: "error",
      detail: errorMessageText(e),
    };
  }
  rows.sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
  return { balances: rows, status: "ok", detail: null };
}

/**
 * Ensure owner ATAs exist for the given mints (idempotent create).
 * Returns ATA public keys in the same order.
 */
export async function ensureOwnerAtas(
  connection: Connection,
  owner: PublicKey,
  mints: PublicKey[],
  sendTransaction: (
    tx: Transaction,
    connection: Connection,
  ) => Promise<string>,
): Promise<PublicKey[]> {
  const atas = mints.map((mint) =>
    getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID),
  );
  const tx = new Transaction();
  let need = false;
  for (let i = 0; i < mints.length; i++) {
    const info = await connection.getAccountInfo(atas[i]);
    if (!info) {
      need = true;
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          owner,
          atas[i],
          owner,
          mints[i],
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
      );
    }
  }
  if (need) {
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    tx.feePayer = owner;
    tx.recentBlockhash = blockhash;
    await sendTransaction(tx, connection);
  }
  return atas;
}

export {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SystemProgram,
  BN,
};

