import { readStoredWeeklyBudgetUsd } from "@/lib/auto-weekly-buy";
import { DEFAULT_SETTINGS } from "@/lib/mock-data";
import {
  adoptWeeklyDraft,
  parseWeeklyDraft,
  readWeeklyDraft,
} from "@/lib/weekly-budget";

export function formatWeeklyDraft(amount: number): string {
  return String(Math.round(amount * 100) / 100);
}

/**
 * Weekly amount Settings shows for this wallet. Reads only.
 * A pre-connect draft is adopted when the wallet has no saved amount.
 * The write itself stays in an effect (`adoptWeeklyDraftForOwner`).
 */
export function settingsWeeklyFromStorage(owner: string | null): {
  amount: number;
  draft: string;
} {
  const sessionDraft = readWeeklyDraft();
  if (!owner) {
    const amount = sessionDraft ?? DEFAULT_SETTINGS.weeklyAmountUsd;
    return { amount, draft: formatWeeklyDraft(amount) };
  }
  const scoped = readStoredWeeklyBudgetUsd(owner);
  const adopted = adoptWeeklyDraft(scoped, sessionDraft);
  const amount = adopted.value ?? DEFAULT_SETTINGS.weeklyAmountUsd;
  const parsed = parseWeeklyDraft(String(amount));
  const next = parsed.ok ? parsed.value : amount;
  return { amount: next, draft: formatWeeklyDraft(next) };
}
