export type PurchaseTone = "ok" | "fail" | "pending";

/**
 * Backup only. A sentence that already says the purchase failed stays red
 * even when the tone was left on "ok".
 */
const PURCHASE_FAIL_TEXT = /nieudany|failed|Could not|Nie udało/i;

/**
 * Color comes from the tone. "pending" is yellow, "fail" is red, "ok" is green.
 * The word check overrides only "ok".
 */
export function purchaseMsgTone(tone: PurchaseTone, text: string): PurchaseTone {
  if (tone === "pending") return "pending";
  if (tone === "fail") return "fail";
  if (PURCHASE_FAIL_TEXT.test(text)) return "fail";
  return "ok";
}

export function purchaseMsgClass(tone: PurchaseTone): string {
  if (tone === "pending") {
    return "border-[#fbbf2433] bg-[#fbbf2411] text-[#fbbf24]";
  }
  if (tone === "fail") {
    return "border-[#f8717133] bg-[#f8717111] text-[#fca5a5]";
  }
  return "border-[#2dd4bf33] bg-[#2dd4bf11] text-[#2dd4bf]";
}
