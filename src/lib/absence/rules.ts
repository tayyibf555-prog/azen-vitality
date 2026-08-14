import { londonDayKey } from "@/lib/time/london";
import type { Availability, Weekday } from "@/lib/rota/types";
import type { Role } from "@/lib/types";
import {
  BLOCKING_STATUSES,
  type Absence,
  type AbsenceKind,
  type AbsenceRequestInput,
  type AbsenceRow,
  type AbsenceSummary,
  ABSENCE_KINDS,
} from "./types";

// ---------------------------------------------------------------------------
// Holiday and absence: every rule, as pure functions.
//
// No React, no database, no `Date.now()`. `now` is a PARAMETER everywhere, the
// same discipline as `rota/generate.ts` (`upcomingWeekStarts(now, weeks)`): a rule
// that reads the clock itself cannot be tested at a chosen date, and this repo has
// already paid for that lesson.
//
// Dates are inclusive London calendar days as `YYYY-MM-DD`. ISO day keys sort
// lexicographically in chronological order, so range comparisons are plain string
// comparisons: no Date objects, no timezone drift, no DST edge.
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/**
 * The roles that may approve or refuse absence.
 *
 * The practice manager is the person who actually approves holiday, and in this
 * platform she is a `client_coordinator`, so the owner-only list would lock out the
 * feature's primary user. This is deliberately NOT `requireOwnerRole`'s list, and
 * `requireOwnerRole` is left untouched: `requireApproverRole` in `@/lib/auth/guard`
 * imports this constant so the HTTP edge and the pure rules can never drift apart.
 */
export const APPROVER_ROLES: readonly Role[] = [
  "agency_admin",
  "client_owner",
  "client_coordinator",
] as const;

/**
 * The roles that may raise a request FOR THEMSELVES AND NOBODY ELSE.
 *
 * Not approvers, and deliberately not an addition to `APPROVER_ROLES`: a nurse
 * asking for a week off is not a nurse deciding she may have it. Both roles here
 * are deny-by-default allow-list roles (CLINICIAN_SLUGS / STAFF_SLUGS), so this
 * is the ONLY thing that lets either of them reach the absence route at all, and
 * `canRequest` still refuses them unless the target staff id is the one resolved
 * from their own session.
 *
 * `client_staff` was added with the self-service surface. Without it a
 * receptionist could open My work, see the holiday tab, and be refused by the
 * rule underneath it — the exact "dead surface" the clinician had before this
 * change (their Holiday page rendered and every call 403'd).
 */
export const SELF_REQUEST_ROLES: readonly Role[] = ["client_clinician", "client_staff"] as const;

/**
 * The longest single request we accept, in inclusive calendar days. A year-long
 * "absence" is almost always a typo in the year field, and it would silently strip a
 * staff member out of every generated rota. Longer genuine leave (maternity, a
 * sabbatical) is recorded as consecutive requests, which stay visible and reviewable.
 */
export const MAX_ABSENCE_SPAN_DAYS = 90;

/** Monday-first weekday keys, indexed by `Date#getUTCDay()` (0 = Sunday). */
const WEEKDAY_BY_UTC_DAY: Weekday[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

/**
 * Whether a string is a real `YYYY-MM-DD` calendar day. The round-trip rejects
 * well-shaped nonsense like `2026-02-30`, which `Date.parse` happily rolls forward
 * into March and which would otherwise be stored as a different day than the one
 * the person typed.
 */
export function isDayKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms)) return false;
  return new Date(ms).toISOString().slice(0, 10) === value;
}

/** Add whole days to a `YYYY-MM-DD` key. UTC-anchored, so DST cannot shift the date. */
export function addDayKey(dayKey: string, days: number): string {
  const ms = Date.parse(`${dayKey}T00:00:00Z`);
  if (Number.isNaN(ms)) return dayKey;
  return new Date(ms + days * DAY_MS).toISOString().slice(0, 10);
}

/** The weekday a `YYYY-MM-DD` key falls on, or null when the key is not a real day. */
export function weekdayOfDayKey(dayKey: string): Weekday | null {
  if (!isDayKey(dayKey)) return null;
  return WEEKDAY_BY_UTC_DAY[new Date(Date.parse(`${dayKey}T00:00:00Z`)).getUTCDay()];
}

/** Inclusive whole-day span between two keys: same day = 1, never negative. */
export function inclusiveDays(startDate: string, endDate: string): number {
  if (!isDayKey(startDate) || !isDayKey(endDate)) return 0;
  const from = Date.parse(`${startDate}T00:00:00Z`);
  const to = Date.parse(`${endDate}T00:00:00Z`);
  if (to < from) return 0;
  return Math.round((to - from) / DAY_MS) + 1;
}

/** A date range with inclusive `YYYY-MM-DD` bounds. */
export interface DateRange {
  startDate: string;
  endDate: string;
}

/**
 * Whether two inclusive date ranges share at least one day.
 *
 * Inclusive is the whole point: someone off Mon to Wed and someone off Wed to Fri DO
 * clash, on the Wednesday. Ranges that merely touch (one ends the day before the
 * other starts) do not.
 */
export function overlaps(a: DateRange, b: DateRange): boolean {
  return a.startDate <= b.endDate && b.startDate <= a.endDate;
}

/**
 * The same person's other outstanding or agreed absences that clash with `candidate`.
 *
 * Only `pending` and `approved` count. A refused or cancelled request is a record of
 * something that did not happen; letting one block a new request would permanently
 * poison a set of dates for that person. The candidate never matches itself, so this
 * is safe to call when re-checking an existing row.
 */
export function findOverlapping(existing: Absence[], candidate: Absence): Absence[] {
  return existing.filter(
    (e) =>
      e.id !== candidate.id &&
      e.staffId === candidate.staffId &&
      BLOCKING_STATUSES.includes(e.status) &&
      overlaps(e, candidate),
  );
}

/**
 * Whether `role` may approve or refuse `absence`.
 *
 * Three separate refusals, and all three matter:
 *  1. the role must be an approver (a clinician requests, they do not decide),
 *  2. only a PENDING request can be decided (no silently re-approving a cancelled
 *     one, which would put someone back on holiday after they cancelled it),
 *  3. nobody approves their own request, even an owner. That is the whole point of
 *     an approval step, and it is enforced here rather than in the route so it
 *     cannot be forgotten by a second caller.
 *
 * `role: null` means auth enforcement is off (the pilot demo), and mirrors
 * `requireOwnerRole`'s no-op-on-null behaviour: the role axis passes, while the
 * status and self-approval rules still apply.
 */
export function canDecide(
  role: Role | null,
  absence: Absence,
  deciderUserId: string | null,
): boolean {
  if (role !== null && !APPROVER_ROLES.includes(role)) return false;
  if (absence.status !== "pending") return false;
  if (deciderUserId !== null && absence.requestedBy !== null && deciderUserId === absence.requestedBy) {
    return false;
  }
  return true;
}

/**
 * Whether `role` may cancel `absence`.
 *
 * An approver can withdraw anything still live; the person who raised the request can
 * always withdraw their own. Already-decided-against and already-cancelled rows are
 * closed.
 */
export function canCancel(
  role: Role | null,
  absence: Absence,
  actorUserId: string | null,
): boolean {
  if (absence.status !== "pending" && absence.status !== "approved") return false;
  if (role === null || APPROVER_ROLES.includes(role)) return true;
  return actorUserId !== null && absence.requestedBy !== null && actorUserId === absence.requestedBy;
}

/**
 * Whether `role` may raise a request for `targetStaffId`.
 *
 * Approvers record absence for anyone (a manager entering a phone call about
 * sickness). A clinician or a member of staff may only ever request their own:
 * `selfStaffId` is resolved server-side from the session, never taken from the
 * request body, so this cannot be spoofed by posting somebody else's staff id.
 *
 * A login with no staff record (`selfStaffId` null) is refused rather than
 * defaulted to anything, which is what makes the unlinked case visible instead of
 * silently filing somebody's holiday against the wrong person.
 */
export function canRequest(
  role: Role | null,
  targetStaffId: string,
  selfStaffId: string | null,
): boolean {
  if (!targetStaffId) return false;
  if (role === null || APPROVER_ROLES.includes(role)) return true;
  if (SELF_REQUEST_ROLES.includes(role)) return selfStaffId !== null && selfStaffId === targetStaffId;
  return false;
}

/**
 * How many of the days in `[start, end]` the person would actually have been working,
 * from their rota availability map. Five days off over a weekend is three working
 * days, and that is the number a manager is deciding about.
 *
 * Reuses the rota's `Availability` weekday map so the two modules cannot disagree
 * about which days someone works. A missing weekday key means not available.
 */
export function workingDaysInRange(
  startDate: string,
  endDate: string,
  availability: Availability,
): number {
  const span = inclusiveDays(startDate, endDate);
  if (span === 0) return 0;
  let count = 0;
  for (let i = 0; i < span; i += 1) {
    const weekday = weekdayOfDayKey(addDayKey(startDate, i));
    if (weekday && availability[weekday] === true) count += 1;
  }
  return count;
}

/** The minimum a shift needs to be tested against an absence. */
export interface ShiftDay {
  staffId: string;
  /** London calendar day, `YYYY-MM-DD`. */
  shiftDate: string;
}

/**
 * The seam into the rota generator: whether this staff member is away on this day.
 *
 * ONLY an approved absence takes someone off the rota. A pending request must not:
 * until a manager has agreed it, the person is still expected in, and silently
 * un-rostering them would leave a day short-staffed with nobody told. A refused or
 * cancelled request obviously never blocks.
 */
export function absenceBlocksShift(shift: ShiftDay, absences: Absence[]): boolean {
  return absences.some(
    (a) =>
      a.staffId === shift.staffId &&
      a.status === "approved" &&
      a.startDate <= shift.shiftDate &&
      shift.shiftDate <= a.endDate,
  );
}

/** Bucket absences by staff id so a generator can look each person up in O(1). */
export function groupAbsencesByStaff(absences: Absence[]): Map<string, Absence[]> {
  const out = new Map<string, Absence[]>();
  for (const a of absences) {
    const list = out.get(a.staffId);
    if (list) list.push(a);
    else out.set(a.staffId, [a]);
  }
  return out;
}

export type ValidationResult = { ok: true } | { ok: false; reason: string };

/** Whether a value is one of the five absence kinds. */
export function isAbsenceKind(value: unknown): value is AbsenceKind {
  return typeof value === "string" && (ABSENCE_KINDS as readonly string[]).includes(value);
}

/**
 * Whether a request is well-formed enough to store, judged against `now`.
 *
 * `now` is a parameter, so "wholly in the past" is testable at a fixed date instead
 * of drifting with the wall clock. The reasons are the message the person sees, so
 * they are written as plain sentences.
 */
export function validateRequest(input: AbsenceRequestInput, now: Date): ValidationResult {
  if (!input.staffId) return { ok: false, reason: "Choose who the absence is for." };
  if (!isAbsenceKind(input.kind)) return { ok: false, reason: "Choose a type of absence." };
  if (!isDayKey(input.startDate) || !isDayKey(input.endDate)) {
    return { ok: false, reason: "Enter a valid start and end date." };
  }
  if (input.endDate < input.startDate) {
    return { ok: false, reason: "The end date cannot be before the start date." };
  }
  // Wholly in the past: the LAST day is already behind us. A range that started
  // yesterday and runs to next week is fine (someone off sick reports it late).
  if (input.endDate < londonDayKey(now)) {
    return { ok: false, reason: "That absence has already finished, so there is nothing to approve." };
  }
  if (inclusiveDays(input.startDate, input.endDate) > MAX_ABSENCE_SPAN_DAYS) {
    return {
      ok: false,
      reason: `An absence cannot be longer than ${MAX_ABSENCE_SPAN_DAYS} days. Record longer leave as separate requests.`,
    };
  }
  return { ok: true };
}

/** Who is looking at the list, for the per-row permission flags. */
export interface AbsenceActor {
  /** null when auth enforcement is off (the pilot demo). */
  role: Role | null;
  /** The actor's app_user id, for the self-approval refusal. */
  userId: string | null;
}

/**
 * Turn stored absences into the rows the UI renders.
 *
 * Every condition a component might otherwise have inlined (may I approve this? is
 * this person already off then? has it finished?) is decided HERE, once, under test.
 * The components take `AbsenceRow[]` and render it.
 */
export function decorateAbsences(
  absences: Absence[],
  actor: AbsenceActor,
  now: Date,
): AbsenceRow[] {
  const today = londonDayKey(now);
  return absences.map((a) => ({
    ...a,
    canDecide: canDecide(actor.role, a, actor.userId),
    canCancel: canCancel(actor.role, a, actor.userId),
    overlapIds: findOverlapping(absences, a).map((o) => o.id),
    days: inclusiveDays(a.startDate, a.endDate),
    past: a.endDate < today,
    current: a.startDate <= today && today <= a.endDate,
  }));
}

/** The three lists the page renders, already ordered. */
export interface AbsencePartition {
  /** Still awaiting a decision, soonest first: the manager's actual to-do list. */
  awaiting: AbsenceRow[];
  /** Decided and not yet finished, soonest first. */
  upcoming: AbsenceRow[];
  /** Finished, most recent first. */
  past: AbsenceRow[];
}

/**
 * Split the rows into the three lists the page shows.
 *
 * This is a rule, not layout, so it lives here under test rather than as three
 * `.filter()` calls inside a React component: which bucket a row belongs in decides
 * whether a manager ever sees it. A PENDING request stays in `awaiting` even once its
 * dates have passed, deliberately. Filing it under "past" would quietly hide a
 * request nobody ever answered, which is the one failure this module exists to
 * prevent.
 */
export function partitionAbsences(rows: AbsenceRow[]): AbsencePartition {
  const byStartAscending = (a: AbsenceRow, b: AbsenceRow) =>
    a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id);
  const byStartDescending = (a: AbsenceRow, b: AbsenceRow) =>
    b.startDate.localeCompare(a.startDate) || a.id.localeCompare(b.id);

  const awaiting = rows.filter((r) => r.status === "pending").sort(byStartAscending);
  const decided = rows.filter((r) => r.status !== "pending");
  return {
    awaiting,
    upcoming: decided.filter((r) => !r.past).sort(byStartAscending),
    past: decided.filter((r) => r.past).sort(byStartDescending),
  };
}

/** The headline figures above the list. Counts only, no formatting. */
export function summariseAbsences(rows: AbsenceRow[]): AbsenceSummary {
  let pending = 0;
  let upcoming = 0;
  let awayToday = 0;
  for (const r of rows) {
    if (r.status === "pending") pending += 1;
    if (r.status === "approved" && !r.past) upcoming += 1;
    if (r.status === "approved" && r.current) awayToday += 1;
  }
  return { pending, upcoming, awayToday, total: rows.length };
}
