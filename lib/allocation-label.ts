/** Digits the allocation legend already prints, then a percent sign. */
export function allocationShareText(share: number): string {
  return `${share}%`;
}

/** Hover label: company name and the same share text as the legend. */
export function allocationTooltipText(name: string, share: number): string {
  return `${name} ${allocationShareText(share)}`;
}
