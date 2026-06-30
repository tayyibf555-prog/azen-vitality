// Display helpers for the ROI (growth) section. Money is always GBP (£), British
// English, no em/en-dash. Small and pure so server and client components share
// them. The money / compact / percent helpers mirror the Meta Ads house style;
// `multipleOrDash` adds null handling for zero-spend channels.

export { money, count, compact, percent } from "@/components/client/meta-ads/format";

/** A return multiple (16.7) rendered as "16.7x", or "-" when there is no spend. */
export function multipleOrDash(value: number | null): string {
  return value === null ? "-" : `${value.toFixed(1)}x`;
}
