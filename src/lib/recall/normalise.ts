import type { RecallTarget, RecallType } from "./types";

export interface RecallConfig {
  // How far before the due date a recall enters the worklist.
  leadWindowDays: number;
  // The boundary past which a recall belongs to reactivation, not recall.
  // MUST equal REACTIVATION_RECALL_GRACE_DAYS to keep the seam airtight.
  graceDays: number;
}

export const DEFAULT_CONFIG: RecallConfig = {
  leadWindowDays: 14,
  graceDays: 60,
};

export interface RecallInput {
  siteId: string;
  // Fields mirror Dentally's real patient object (top-level consent booleans,
  // marketing as 0/1 or boolean, recall dates per provider type).
  patient: {
    id: string;
    first_name: string;
    last_name: string;
    use_sms?: boolean;
    use_email?: boolean;
    marketing?: number | boolean;
    dentist_recall_date?: string | null;
    hygienist_recall_date?: string | null;
  };
  lastVisitAt: string | null;     // most recent past appointment date
  futureBookingExists: boolean;   // any appointment in the future
}

const DAY = 86_400_000;

/** (now - dueIso) in days. Positive = overdue, negative = due in future. */
function overdueDaysBetween(dueIso: string, now: Date): number {
  const t = new Date(dueIso).getTime();
  // An unparseable date must never enter the window; fail safe to "too early".
  if (Number.isNaN(t)) return Number.NEGATIVE_INFINITY;
  return (now.getTime() - t) / DAY;
}

const RECALL_DATES: { type: RecallType; key: "dentist_recall_date" | "hygienist_recall_date" }[] = [
  { type: "dentist", key: "dentist_recall_date" },
  { type: "hygienist", key: "hygienist_recall_date" },
];

/**
 * Turn a patient into 0, 1 or 2 recall targets, one per provider recall that
 * falls inside the proactive window: from `leadWindowDays` before the due date
 * through `graceDays` overdue. A patient with a future booking is never a
 * recall candidate (they are already coming in).
 */
export function classifyRecall(
  i: RecallInput,
  now: Date,
  cfg: RecallConfig = DEFAULT_CONFIG,
): RecallTarget[] {
  if (i.futureBookingExists) return [];

  const consent = {
    sms: Boolean(i.patient.use_sms),
    email: Boolean(i.patient.use_email),
    marketing: Boolean(i.patient.marketing),
  };
  const patientName = `${i.patient.first_name} ${i.patient.last_name}`.trim();

  const targets: RecallTarget[] = [];
  for (const { type, key } of RECALL_DATES) {
    const due = i.patient[key];
    if (typeof due !== "string" || due === "") continue;

    const overdue = overdueDaysBetween(due, now);
    // Inside the window: due within the lead, and not past the grace boundary.
    if (overdue < -cfg.leadWindowDays || overdue > cfg.graceDays) continue;

    targets.push({
      id: `${i.siteId}:${i.patient.id}:${type}`,
      siteId: i.siteId,
      dentallyPatientId: i.patient.id,
      patientName,
      recallType: type,
      dueAt: due,
      overdueDays: Math.round(overdue),
      lastVisitAt: i.lastVisitAt,
      priorAttempts: 0,
      status: "due",
      consent,
      updatedFromDentallyAt: now.toISOString(),
    });
  }
  return targets;
}

/** Most overdue / soonest due first. Recall is a time-ordered queue, not value-ranked. */
export function rankByDue(targets: RecallTarget[]): RecallTarget[] {
  return [...targets].sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());
}

/** A recall graduates to reactivation once it ages past the grace boundary. */
export function shouldGraduate(overdueDays: number, graceDays: number): boolean {
  return overdueDays > graceDays;
}
