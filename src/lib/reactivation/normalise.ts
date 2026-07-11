import type { ReactivationReason, ReactivationTarget } from "./types";

export interface ReactivationConfig {
  lapseMonths: number;
  /** Upper bound on the lapse window: a patient last seen longer ago than this is too
   *  cold to be worth reactivating and is excluded (default 12 months = 1 year, the
   *  practice's hard maximum — nobody lapsed longer than a year is auto-contacted). */
  maxLapseMonths: number;
  recallGraceDays: number;
  staleDays: number;
  baselineValue: number;
}

export const DEFAULT_CONFIG: ReactivationConfig = {
  // Lapsed-detection threshold. Must sit BELOW maxLapseMonths or the lapsed window
  // is empty (9..12 months: recall's 60-day seam hands over well before 9 months).
  lapseMonths: 9,
  maxLapseMonths: 12,
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
    /** Dentally `active` flag. false = deactivated / left the practice (not a live patient). */
    active?: boolean;
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
  const t = new Date(fromIso).getTime();
  // An unparseable date must never count as overdue or stale; fail safe.
  if (Number.isNaN(t)) return Number.NEGATIVE_INFINITY;
  return (now.getTime() - t) / DAY;
}

/** The recall date that is most overdue (earliest past date among the two set). */
function overdueRecallDate(i: ReactivationInput, now: Date, graceDays: number): string | null {
  const candidates = [i.patient.dentist_recall_date, i.patient.hygienist_recall_date]
    .filter((d): d is string => typeof d === "string" && d !== "")
    .filter((d) => daysBetween(d, now) > graceDays);
  if (candidates.length === 0) return null;
  // earliest (most overdue) first; numeric sort is robust to ISO format differences.
  return candidates.sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0];
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
  // An archived patient (deceased, moved away, duplicate record) must NEVER be
  // auto-contacted. The ONE exception is a patient explicitly archived as 'lapsed' —
  // that is precisely the cohort reactivation exists to win back. Any other archived
  // reason (or archived with no reason) is excluded outright, so a deceased patient
  // can never be texted "we miss you, come back for a check-up".
  if (i.patient.archived && i.patient.archived_reason !== "lapsed") return null;

  // Inactive / deactivated in Dentally (active === false): they have left the practice,
  // so reactivating them is wasted effort and risks contacting someone off the books.
  // Skip regardless of reason. (undefined active => flag absent => treated as active.)
  if (i.patient.active === false) return null;

  // Hard lapse ceiling (default 1 year): a patient we cannot PROVE was seen inside
  // the window is excluded — that covers a last visit older than maxLapseMonths, NO
  // recorded visit at all, and an unparseable date. Fail closed: "we miss you" must
  // never go to someone whose relationship with the practice can't be verified as
  // recent. (Stalled treatment plans for such patients still surface in the
  // Treatment Coordinator worklist; they just don't get reactivation texts.)
  const sinceVisit = i.lastVisitAt ? daysBetween(i.lastVisitAt, now) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(sinceVisit) || sinceVisit > cfg.maxLapseMonths * 30) return null;

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
