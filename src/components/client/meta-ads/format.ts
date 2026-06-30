// Display helpers for the Meta Ads section. Money is always GBP (£), British
// English, no em/en-dash. Kept small and pure so both server and client
// components can share them.

import type { AdFormat, CampaignObjective } from "@/lib/meta-ads/types";

const GBP_0 = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  maximumFractionDigits: 0,
});

const GBP_2 = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const NUM = new Intl.NumberFormat("en-GB");

/** £1,907 (whole pounds) or £34.05 (pence) depending on `pence`. */
export function money(value: number, pence = false): string {
  return (pence ? GBP_2 : GBP_0).format(value);
}

/** A budget shown to the penny only when it has a fractional part: £18, £34.22. */
export function budget(value: number): string {
  return Number.isInteger(value) ? GBP_0.format(value) : GBP_2.format(value);
}

/** 1,170 with en-GB thousands separators. */
export function count(value: number): string {
  return NUM.format(value);
}

/** Compact long counts for impressions / reach: 277,000 -> "277k", 1,100,000 -> "1.1m". */
export function compact(value: number): string {
  if (value >= 1_000_000) {
    const m = value / 1_000_000;
    return `${Number.isInteger(m) ? m.toFixed(0) : m.toFixed(1)}m`;
  }
  if (value >= 1_000) {
    const k = value / 1_000;
    return `${Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)}k`;
  }
  return NUM.format(value);
}

/** A click-through fraction (0.0149) rendered as a percentage string ("1.5%"). */
export function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/** A rough return multiple (4.3) rendered as "4.3x". */
export function multiple(value: number): string {
  return `${value.toFixed(1)}x`;
}

const OBJECTIVE_LABELS: Record<CampaignObjective, string> = {
  awareness: "Awareness",
  leads: "Leads",
  traffic: "Traffic",
  engagement: "Engagement",
  retargeting: "Retargeting",
};

/** Human label for a campaign objective ("leads" -> "Leads"). */
export function objectiveLabel(objective: CampaignObjective): string {
  return OBJECTIVE_LABELS[objective] ?? objective;
}

const FORMAT_LABELS: Record<AdFormat, string> = {
  reel: "Reel (9:16 video)",
  image: "Single image",
  carousel: "Carousel",
  video: "In-feed video",
};

const FORMAT_SHORT: Record<AdFormat, string> = {
  reel: "Reel",
  image: "Image",
  carousel: "Carousel",
  video: "Video",
};

/** Full, descriptive label for an ad format. */
export function formatLabel(format: AdFormat): string {
  return FORMAT_LABELS[format] ?? format;
}

/** Short label for an ad format pill. */
export function formatShort(format: AdFormat): string {
  return FORMAT_SHORT[format] ?? format;
}
