// ---------------------------------------------------------------------------
// The PATIENTS and TREATMENT PLANS sub-columns.
//
//   Patients:        new / seen / active
//   Treatment plans: started / finished / open
//
// Six small numbers, and the trap in all six is the same: a count of zero and a
// count we cannot source look identical once rendered. "0 new patients this
// month" is a fact the practice manager would act on; "we could not read the
// registration date" is not. So each count is `number | null`, and null is
// returned whenever the source set does not carry the field the count depends
// on at all. A window that genuinely contains nothing still returns 0.
//
// Pure functions only.
// ---------------------------------------------------------------------------

import { countPatientsSeen } from "@/lib/dashboard/appointments";
import type {
  DashboardAppointment,
  DashboardPatient,
  DashboardTreatmentPlan,
} from "@/lib/dashboard/normalise";
import { isDayInWindow, type DayWindow } from "@/lib/dashboard/period";

export interface PatientCounts {
  /** Registered in the window. Null when no patient record carries a creation date. */
  newCount: number | null;
  /** Distinct patients with a completed appointment in the window. */
  seenCount: number | null;
  /** Active, non-archived patients on the books. Not window scoped. */
  activeCount: number | null;
}

export interface PatientCountsInput {
  /** Null when the caller could not fetch the patient list. */
  patients: readonly DashboardPatient[] | null;
  /** Null when the caller could not fetch appointments. */
  appointments: readonly DashboardAppointment[] | null;
  window: DayWindow;
  siteId?: string | null;
}

export function computePatientCounts(input: PatientCountsInput): PatientCounts {
  const siteId = input.siteId ?? null;

  let newCount: number | null = null;
  let activeCount: number | null = null;

  if (input.patients !== null) {
    const scoped =
      siteId === null ? input.patients : input.patients.filter((p) => p.siteId === siteId);

    // Field presence is checked against the WHOLE scoped set, not per row: if not
    // one patient carries a creation date then this source cannot answer "new",
    // and a zero would be a fabrication.
    if (scoped.some((p) => p.createdDay !== null)) {
      newCount = scoped.filter((p) => p.createdDay !== null && isDayInWindow(p.createdDay, input.window)).length;
    }
    if (scoped.some((p) => p.active !== null)) {
      activeCount = scoped.filter((p) => p.active === true && !p.archived).length;
    }
  }

  const seenCount =
    input.appointments === null
      ? null
      : countPatientsSeen({ appointments: input.appointments, window: input.window, siteId });

  return { newCount, seenCount, activeCount };
}

export interface TreatmentPlanCounts {
  /** Plans that started in the window. */
  started: number | null;
  /** Plans that finished in the window. */
  finished: number | null;
  /** Plans started on or before the window's last day and not finished by it. */
  open: number | null;
}

export interface TreatmentPlanCountsInput {
  /** Null when the caller could not fetch plans. */
  plans: readonly DashboardTreatmentPlan[] | null;
  window: DayWindow;
  siteId?: string | null;
}

export function computeTreatmentPlanCounts(
  input: TreatmentPlanCountsInput,
): TreatmentPlanCounts {
  if (input.plans === null) return { started: null, finished: null, open: null };
  const siteId = input.siteId ?? null;
  const scoped = siteId === null ? input.plans : input.plans.filter((p) => p.siteId === siteId);

  const hasStart = scoped.some((p) => p.startedDay !== null);
  // A finish DATE on at least one plan, or a finish FIELD present at all (even
  // null on every row, which honestly means "none finished"), makes the finished
  // and open counts answerable.
  const hasFinishField = scoped.some((p) => p.hasFinishField);

  const started = hasStart
    ? scoped.filter((p) => p.startedDay !== null && isDayInWindow(p.startedDay, input.window)).length
    : null;

  const finished = hasFinishField
    ? scoped.filter((p) => p.finishedDay !== null && isDayInWindow(p.finishedDay, input.window)).length
    : null;

  const open =
    hasStart && hasFinishField
      ? scoped.filter(
          (p) =>
            p.startedDay !== null &&
            p.startedDay <= input.window.to &&
            (p.finishedDay === null || p.finishedDay > input.window.to),
        ).length
      : null;

  return { started, finished, open };
}
