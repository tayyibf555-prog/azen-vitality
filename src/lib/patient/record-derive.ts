import { fundingFromPlanId, type FundingCode } from "@/lib/calendar/funding";
import {
  isAttendedState,
  isCancelledState,
  isDidNotAttendState,
  isLiveBookingState,
} from "@/lib/dentally/appointment-state";
import type { AppointmentRecord, PatientDetail, PatientRecord } from "@/lib/dentally/read";

/**
 * Every figure the patient record shows, derived ONCE from one server read.
 *
 * PURE. No I/O, no Date.now(): `now` is passed in.
 *
 * WHY THIS EXISTS, and it is the deliverable rather than the code. The record has
 * two surfaces: the full page and the quick-view drawer opened from the diary, the
 * dashboard and the command palette. Before this module the drawer computed
 * lastSeen, nextAppt and visits CLIENT-side from its own fetch while lifetimeSpend
 * and outstanding came from the server, so two surfaces on that split would have
 * disagreed about the same patient on day one. Nothing renders a figure it computed
 * itself; both surfaces call this, and both are handed the same object.
 *
 * TIME ZONE. Ages and dates are computed from the calendar day, not from an instant.
 * A date of birth is a bare date with no time zone, so it is read as UTC calendar
 * parts, and `now` is read as its Europe/London calendar parts. That way a patient
 * born on 1 August turns a year older at London midnight, not at 01:00 in summer.
 */

/**
 * WHICH APPOINTMENT COUNTS AS WHAT is decided by lib/dentally/appointment-state.ts
 * and nowhere else.
 *
 * This module used to carry its own allow-list, `new Set(["booked", "pending"])`.
 * "booked" is the MOCK's word; live Dentally never sends it, and it sends
 * "Confirmed", "Arrived" and "In surgery", none of which were in the set. So the
 * moment a patient replied YES to a confirmation SMS and Dentally moved the
 * appointment to Confirmed, this record printed "Next appointment: None booked" for
 * a patient booked in that afternoon, on BOTH the record page and the quick view.
 * The fixtures every future appointment is "booked" in are why it was invisible.
 */

export interface PatientDerived {
  /** Whole years, or null when there is no date of birth. NEVER 0 as a stand-in. */
  ageYears: number | null;
  /** Dentally's own format, "59y 2m". Null when there is no date of birth. */
  ageLabel: string | null;
  /** Newest ATTENDED appointment, else the patient record's own lastVisitAt. */
  lastSeenAt: string | null;
  /** Practitioner on that newest attended appointment, when Dentally named one. */
  lastSeenBy: string | null;
  /** Soonest FUTURE appointment that is still live. Cancelled, did-not-attend and
   *  completed rows excluded; every other state counts, including ones Dentally may
   *  add later. */
  nextAppointment: AppointmentRecord | null;
  completedVisits: number;
  didNotAttendCount: number;
  cancelledCount: number;
  lifetimeSpend: number;
  outstanding: number;
  /** Money the practice owes THIS patient (an overpayment or a refund due), as a
   *  positive number. Held separately from `outstanding` so no caller's sign test
   *  changes meaning; zero in the normal case. */
  credit: number;
  totalInvoiced: number;
  funding: FundingCode;
  dentistRecallAt: string | null;
  hygienistRecallAt: string | null;
}

/** The calendar day parts of an instant, in Europe/London. */
function londonParts(now: Date): { year: number; month: number; day: number } {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day") };
}

/** The calendar day parts of a date of birth, read as a bare date (UTC). */
function dobParts(dob: string): { year: number; month: number; day: number } | null {
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * Whole years and whole months since birth, e.g. { years: 59, months: 2 }.
 * Null for an absent or unparseable date of birth, and null for a date in the
 * future, which is a data error rather than a negative age.
 */
export function ageParts(dob: string | null, now: Date): { years: number; months: number } | null {
  if (!dob) return null;
  const b = dobParts(dob);
  if (!b) return null;
  const t = londonParts(now);

  let years = t.year - b.year;
  let months = t.month - b.month;
  if (t.day < b.day) months -= 1;
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  if (years < 0) return null;
  return { years, months };
}

/** Whole years of age, or null. Never 0 as a stand-in for "unknown". */
export function ageYears(dob: string | null, now: Date): number | null {
  return ageParts(dob, now)?.years ?? null;
}

/** Dentally's own age format, "59y 2m". Null when there is no date of birth. */
export function ageLabel(dob: string | null, now: Date): string | null {
  const p = ageParts(dob, now);
  return p ? `${p.years}y ${p.months}m` : null;
}

/**
 * Everything the record shows, from one patient record and one detail read.
 *
 * Cancelled and did-not-attend appointments are EXCLUDED from lastSeenAt and from
 * nextAppointment, and counted separately: a cancelled future booking must never
 * present as the next appointment, and a did-not-attend must never present as a
 * visit. Both counts are shown, because a patient's DNA history is clinically and
 * commercially material and hiding it was one of the defects this rebuild fixes.
 */
export function derivePatient(patient: PatientRecord, detail: PatientDetail, now: Date): PatientDerived {
  const nowIso = now.toISOString();
  const appts = detail.appointments;

  const attended = appts.filter((a) => isAttendedState(a.state));
  // The detail read sorts newest first, but this must not depend on that: sort a copy.
  const attendedNewestFirst = [...attended].sort((a, b) => (a.start < b.start ? 1 : -1));
  const newestAttended = attendedNewestFirst[0] ?? null;

  const nextAppointment =
    [...appts]
      .filter((a) => a.start > nowIso && isLiveBookingState(a.state))
      .sort((a, b) => (a.start > b.start ? 1 : -1))[0] ?? null;

  const parts = ageParts(patient.dateOfBirth, now);

  return {
    ageYears: parts?.years ?? null,
    ageLabel: parts ? `${parts.years}y ${parts.months}m` : null,
    lastSeenAt: newestAttended?.start ?? patient.lastVisitAt,
    lastSeenBy: newestAttended?.practitioner ?? null,
    nextAppointment,
    completedVisits: attended.length,
    didNotAttendCount: appts.filter((a) => isDidNotAttendState(a.state)).length,
    cancelledCount: appts.filter((a) => isCancelledState(a.state)).length,
    lifetimeSpend: detail.lifetimeSpend,
    outstanding: detail.outstanding,
    credit: detail.credit,
    totalInvoiced: detail.totalInvoiced,
    funding: fundingFromPlanId(patient.paymentPlanId),
    dentistRecallAt: patient.dentistRecallAt,
    hygienistRecallAt: patient.hygienistRecallAt,
  };
}

/**
 * What the Balance slot says, in one place, so the header, the summary line and the
 * Account card cannot word it three ways.
 *
 * A CREDIT IS NOT A ZERO. A patient who overpaid £120 at reception was shown
 * "Balance £0.00" in navy, because the outstanding total clamps each invoice's
 * balance at zero. Dentally's own account screen - the thing this page exists to
 * mirror - shows the credit, and "nothing owed either way" is a positive claim
 * standing in for a figure we hold and threw away.
 *
 * `tone` is what the caller colours by, so "owed" is the only case that goes red.
 */
export function balanceLabel(
  outstanding: number,
  credit: number,
  format: (n: number) => string,
): { text: string; tone: "owed" | "credit" | "settled" } {
  if (outstanding > 0) return { text: format(outstanding), tone: "owed" };
  if (credit > 0) return { text: `${format(credit)} in credit`, tone: "credit" };
  return { text: format(0), tone: "settled" };
}
