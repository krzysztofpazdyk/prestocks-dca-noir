/** A purchase line stored as a translation key, rendered in the active language. */
export type PurchaseNotice = {
  key: string;
  vars?: Record<string, string | number>;
  /** Raw wallet or RPC text appended after ": ". */
  detail?: string;
  /** Append the live buy preview, which is itself re-translated. */
  withPreview?: boolean;
};

type Translate = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

export function renderPurchaseNotice(
  notice: PurchaseNotice,
  translate: Translate,
  preview?: string | null,
): string {
  const body = translate(notice.key, notice.vars);
  const withDetail = notice.detail ? `${body}: ${notice.detail}` : body;
  if (notice.withPreview && preview) return `${withDetail} ${preview}`;
  return withDetail;
}
