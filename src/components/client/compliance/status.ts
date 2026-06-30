// Display helpers for the Compliance section: status to tone/label mapping and
// en-GB date formatting. Pure (no React, no network) so server and client
// components can share them. British English, no em/en-dash.

import type { Tone } from "@/components/primitives";
import type { ComplianceStatus, PolicyDoc } from "@/lib/compliance/types";

/** Every status value that can appear on an item or pill across the section. */
export type ItemStatus = ComplianceStatus | PolicyDoc["status"];

const TONES: Record<ItemStatus, Tone> = {
  // Good, in place.
  compliant: "success",
  in_place: "success",
  // Approaching, attention soon.
  due_soon: "warning",
  review_due: "warning",
  action_needed: "warning",
  // Past due, gap.
  overdue: "danger",
  missing: "danger",
  // No record yet.
  not_started: "neutral",
};

const LABELS: Record<ItemStatus, string> = {
  compliant: "Compliant",
  in_place: "In place",
  due_soon: "Due soon",
  review_due: "Review due",
  action_needed: "Action needed",
  overdue: "Overdue",
  missing: "Missing",
  not_started: "Not started",
};

/** StatusPill tone for any item status. */
export function statusTone(status: ItemStatus): Tone {
  return TONES[status] ?? "neutral";
}

/** Human label for any item status ("due_soon" -> "Due soon"). */
export function statusLabel(status: ItemStatus): string {
  return LABELS[status] ?? status;
}

/**
 * Sort weight so attention-needing items float to the top: overdue/missing
 * first, then the due-soon family, then everything in order. Lower is sorted
 * earlier.
 */
export function statusWeight(status: ItemStatus): number {
  switch (status) {
    case "overdue":
    case "missing":
      return 0;
    case "due_soon":
    case "review_due":
    case "action_needed":
      return 1;
    case "not_started":
      return 2;
    default:
      return 3;
  }
}

const DATE_FMT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

/**
 * Format an ISO date as en-GB ("5 Jun 2026"). When the date is missing, return
 * the supplied fallback ("Not recorded" by default, or "-" for compact cells).
 */
export function fmtDate(iso: string | null, fallback = "Not recorded"): string {
  if (!iso) return fallback;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return fallback;
  return DATE_FMT.format(d);
}
