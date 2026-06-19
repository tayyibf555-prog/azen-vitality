import type { ReactivationReason, ReactivationTarget } from "./types";

export interface ReactivationConfig {
  lapseMonths: number;
  recallGraceDays: number;
  staleDays: number;
  baselineValue: number;
}

export const DEFAULT_CONFIG: ReactivationConfig = {
  lapseMonths: 18,
  recallGraceDays: 60,
  staleDays: 120,
  baselineValue: 80,
};

export interface ReactivationInput {
  siteId: string;
  // Fields mirror Dentally's real patient object (top-level consent booleans,
  // marketing as 0/1 or boolean, archived flags, recall dates).
  patient: {
    id: string;
    first_name: string;
    last_name: string;
    use_sms?: boolean;
    use_email?: boolean;
    marketing?: number | boolean;
    archived?: boolean;
    archived_reason?: string | null;
    dentist_recall_date?: string | null;
    hygienist_recall_date?: string | null;
  };
  lastVisitAt: string | null;          // most recent appointment date (past)
  futureBookingExists: boolean;        // any appointment in the future
  plan: { id: string; name: string; planned_private_treatment_value: number; accepted_at: string } | null;
  amountOutstanding: number;           // outstanding on the open plan (0 if none)
  historicSpend: number;               // sum of paid invoices, lifetime
  lastTouchAt: string | null;
}

const DAY = 86_400_000;

function daysBetween(fromIso: string, now: Date): number {
  return (now.getTime() - new Date(fromIso).getTime()) / DAY;
}

/** The recall date that is most overdue (earliest past date among the two set). */
function overdueRecallDate(i: ReactivationInput, now: Date, graceDays: number): string | null {
  const candidates = [i.patient.dentist_recall_date, i.patient.hygienist_recall_date]
    .filter((d): d is string => typeof d === "string" && d !== "")
    .filter((d) => daysBetween(d, now) > graceDays);
  if (candidates.length === 0) return null;
  return candidates.sort()[0]; // earliest = most overdue
}

function deriveReason(i: ReactivationInput, now: Date, cfg: ReactivationConfig): ReactivationReason | null {
  // Priority: stalled_plan > overdue_recall > lapsed.
  if (i.plan && i.amountOutstanding > 0 && daysBetween(i.plan.accepted_at, now) > cfg.staleDays) {
    return "stalled_plan";
  }
  if (!i.futureBookingExists && overdueRecallDate(i, now, cfg.recallGraceDays)) {
    return "overdue_recall";
  }
  const lapseDays = cfg.lapseMonths * 30;
  const noRecentVisit = !i.lastVisitAt || daysBetween(i.lastVisitAt, now) > lapseDays;
  if (i.patient.archived_reason === "lapsed" || (noRecentVisit && !i.futureBookingExists)) {
    return "lapsed";
  }
  return null;
}

function deriveValue(i: ReactivationInput, reason: ReactivationReason, cfg: ReactivationConfig): number {
  if (reason === "stalled_plan" && i.amountOutstanding > 0) return i.amountOutstanding;
  if (i.historicSpend > 0) return i.historicSpend;
  return cfg.baselineValue;
}

export function toReactivationTarget(
  i: ReactivationInput,
  now: Date,
  cfg: ReactivationConfig = DEFAULT_CONFIG,
): ReactivationTarget | null {
  const reason = deriveReason(i, now, cfg);
  if (!reason) return null;

  const recallDueAt = overdueRecallDate(i, now, cfg.recallGraceDays);

  return {
    id: `${i.siteId}:${i.patient.id}`,
    siteId: i.siteId,
    dentallyPatientId: i.patient.id,
    patientName: `${i.patient.first_name} ${i.patient.last_name}`.trim(),
    reason,
    dentallyPlanId: reason === "stalled_plan" && i.plan ? i.plan.id : null,
    treatment: reason === "stalled_plan" && i.plan ? i.plan.name : null,
    recoverableValue: deriveValue(i, reason, cfg),
    lastVisitAt: i.lastVisitAt,
    recallDueAt,
    priorAttempts: 0,
    status: "dormant",
    reactivationScore: 0,
    consent: {
      sms: Boolean(i.patient.use_sms),
      email: Boolean(i.patient.use_email),
      marketing: Boolean(i.patient.marketing),
    },
    updatedFromDentallyAt: now.toISOString(),
  };
}
