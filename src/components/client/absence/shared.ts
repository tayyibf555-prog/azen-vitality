import type { Tone } from "@/components/primitives";
import type { AbsenceKind, AbsenceStatus } from "@/lib/absence/types";
import { ABSENCE_KINDS } from "@/lib/absence/types";

// Presentation helpers for the Holiday and absence tabs: labels, tones and date
// formatting. Pure display, no rules. Every DECISION (may I approve this, does it
// clash, has it finished) is computed in `@/lib/absence/rules` and arrives on the
// row already decided, the same split the rota components use.

export { ABSENCE_KINDS };

/** How each kind is named to a practice manager. */
export const KIND_LABEL: Record<AbsenceKind, string> = {
  holiday: "Holiday",
  sick: "Sickness",
  training: "Training",
  unpaid: "Unpaid leave",
  other: "Other",
};

/** How each status reads in the list. */
export const STATUS_LABEL: Record<AbsenceStatus, string> = {
  pending: "Awaiting decision",
  approved: "Approved",
  refused: "Refused",
  cancelled: "Cancelled",
};

/** Status tint. Only the row that needs an action carries a warm tone. */
export const STATUS_TONE: Record<AbsenceStatus, Tone> = {
  pending: "warning",
  approved: "success",
  refused: "neutral",
  cancelled: "neutral",
};

/** A "Mon 6 Jul" style label for a `YYYY-MM-DD` day, in London. */
export function dayLabel(dayKey: string): string {
  const ms = Date.parse(`${dayKey}T12:00:00Z`);
  if (Number.isNaN(ms)) return dayKey;
  return new Date(ms).toLocaleDateString("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/** "Mon 6 Jul to Fri 10 Jul", collapsing to a single date for a one day absence. */
export function rangeLabel(startDate: string, endDate: string): string {
  return startDate === endDate ? dayLabel(startDate) : `${dayLabel(startDate)} to ${dayLabel(endDate)}`;
}

/** "5 days" / "1 day". */
export function daysLabel(days: number): string {
  return `${days} ${days === 1 ? "day" : "days"}`;
}

/** Map a staff id to a name, falling back to something readable rather than a uuid. */
export function staffName(staff: { id: string; name: string }[], staffId: string): string {
  return staff.find((s) => s.id === staffId)?.name ?? "Unknown staff member";
}
