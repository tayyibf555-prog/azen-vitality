import type { ReactivationReason, ReactivationTarget } from "./types";

/** "No outer edge on the lapse window." The practice asked for EVERY lapsed patient
 *  to be reachable, not only those lapsed under a year, so this is the default. It is
 *  a real number so the same `days <= max * 30` arithmetic works untouched. */
export const UNLIMITED_MAX_LAPSE_MONTHS = Number.POSITIVE_INFINITY;

export interface ReactivationConfig {
  lapseMonths: number;
  /** Upper bound on the lapse window: a patient last seen longer ago than this is
   *  excluded. UNLIMITED by default. The practice can set an outer edge later,
   *  per-client via reactivation_settings.max_lapse_months (see settings.ts) or
   *  deployment-wide via REACTIVATION_MAX_LAPSE_MONTHS, without a code change. */
  maxLapseMonths: number;
  recallGraceDays: number;
  staleDays: number;
  baselineValue: number;
}

export const DEFAULT_CONFIG: ReactivationConfig = {
  // Lapsed-detection threshold, UNCHANGED: recall's 60-day seam hands over well
  // before 9 months, so the two modules never chase the same patient at once. Must
  // sit BELOW maxLapseMonths (trivially true while that is unlimited) or the lapsed
  // window is empty.
  lapseMonths: 9,
  maxLapseMonths: UNLIMITED_MAX_LAPSE_MONTHS,
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

/** The deployment-wide lapse ceiling in months: the env override when it is a valid
 *  positive number, else unlimited. A malformed override must degrade to the default,
 *  never to NaN, since `x > NaN * 30` is always false, which reads as "no ceiling" whether
 *  or not that is what the operator asked for. This is the value every choke point
 *  uses when it is not handed a per-client one (see settings.getMaxLapseMonths). */
export function effectiveMaxLapseMonths(): number {
  const raw = process.env.REACTIVATION_MAX_LAPSE_MONTHS;
  if (raw === undefined) return DEFAULT_CONFIG.maxLapseMonths;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(
      `[reactivation] invalid REACTIVATION_MAX_LAPSE_MONTHS ${JSON.stringify(raw)}; using default ${DEFAULT_CONFIG.maxLapseMonths}`,
    );
    return DEFAULT_CONFIG.maxLapseMonths;
  }
  return n;
}

/** True when a stored last visit PROVABLY sits inside the lapse window. With no
 *  configured maximum that means "we can prove they attended at all"; with one it
 *  means "and inside it".
 *  Fail closed: no visit, an unparseable date, and over-window all return false.
 *  Shared by every choke point that can start or continue contact for an EXISTING
 *  target row (manual enrol, manual draft, the sweep) — stored rows age while the
 *  sync only re-pulls patients Dentally marks updated, so the window must be
 *  re-checked wherever a message could actually be produced. */
export function withinLapseWindow(
  lastVisitAt: string | null,
  now: Date,
  maxLapseMonths: number = effectiveMaxLapseMonths(),
): boolean {
  if (!lastVisitAt) return false;
  const days = daysBetween(lastVisitAt, now);
  return Number.isFinite(days) && days <= maxLapseMonths * 30;
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

  // Lapse ceiling, UNLIMITED unless the practice configures one. What survives with
  // no ceiling is the proof requirement: NO recorded visit at all, or an unparseable
  // date, is still excluded. Fail closed: "we miss you" must never go to someone we
  // cannot show ever attended, however far the outer edge is pushed out. (Stalled
  // treatment plans for such patients still surface in the Treatment Coordinator
  // worklist; they just don't get reactivation texts.)
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
