import { londonDayKey } from "@/lib/time/london";
import { absenceBlocksShift, isDayKey } from "@/lib/absence/rules";
import type { Absence } from "@/lib/absence/types";
import { isLiveShift, resolvePairRoles, type RotaConfig, type RotaShift, type RotaShiftOrigin } from "./types";

// ---------------------------------------------------------------------------
// Manual rota editing: every rule, as pure functions.
//
// No React, no database, no `Date.now()`. `now` is a PARAMETER, the same discipline
// as `rota/generate.ts` and `absence/rules.ts`. A rule that lives inside a React
// closure cannot be tested at a chosen date and cannot be tested at all in this
// repo (vitest collects only `src/**/*.test.ts`, node environment, no .tsx), so
// "the component decides" would mean "nobody checks".
//
// Times are wall-clock `HH:MM` strings and dates are London calendar days as
// `YYYY-MM-DD`. Both sort lexicographically in chronological order, so every
// comparison here is a plain string comparison: no Date objects, no DST edge.
// ---------------------------------------------------------------------------

/** `HH:MM`, 00:00 to 23:59. Rejects "9:00", "24:00" and "09:60". */
export function isTimeOfDay(value: unknown): value is string {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** The fields a manager can set on a shift, whether creating one or moving one. */
export interface ShiftEditInput {
  /** Present when editing an existing shift, absent when creating one. */
  id?: string;
  siteId: string;
  staffId: string;
  shiftDate: string;
  startTime: string;
  endTime: string;
  role: string;
  pairedStaffId?: string | null;
  note?: string | null;
}

/**
 * One thing wrong with an edit.
 *
 * `error` refuses the edit; `warning` lets it through and says so. The split is the
 * feature, not a nicety: a manager rostering somebody who booked that day off is
 * usually covering an emergency and knows exactly what they are doing, and a system
 * that refuses it gets worked around on paper, where nothing is recorded at all.
 * A person in two places at once is different: that is not a judgement call, it is
 * impossible, so it is an error.
 */
export interface EditIssue {
  level: "error" | "warning";
  code:
    | "missing-field"
    | "bad-date"
    | "bad-time"
    | "end-before-start"
    | "double-booked"
    | "paired-with-self"
    | "past-day"
    | "on-approved-absence";
  /** Plain-sentence copy, shown to the person making the edit. */
  message: string;
}

export interface EditValidation {
  /** True when nothing at `error` level was found. Warnings do not block. */
  ok: boolean;
  issues: EditIssue[];
}

const MAX_NOTE_LENGTH = 500;

/**
 * Whether two wall-clock windows on the same day overlap.
 *
 * Touching is NOT overlapping: a 09:00 to 13:00 and a 13:00 to 17:30 are a morning
 * and an afternoon, which is a normal split shift, and refusing it would make
 * half-days impossible to record.
 */
export function timesOverlap(
  a: { startTime: string; endTime: string },
  b: { startTime: string; endTime: string },
): boolean {
  return a.startTime < b.endTime && b.startTime < a.endTime;
}

/**
 * Whether this shift would put its staff member in two places at once.
 *
 * Only LIVE shifts count. A cancelled or tombstoned row is a record of something
 * that is not happening, and letting one block a new shift would permanently poison
 * a slot: delete a shift, then find you cannot re-create it.
 *
 * A shift never clashes with itself, so this is safe to call when re-checking a row
 * that is being moved.
 */
export function wouldDoubleBook(
  shift: Pick<ShiftEditInput, "id" | "staffId" | "shiftDate" | "startTime" | "endTime">,
  dayShifts: RotaShift[],
): boolean {
  return dayShifts.some(
    (other) =>
      other.id !== undefined &&
      other.id !== shift.id &&
      other.staffId === shift.staffId &&
      other.shiftDate === shift.shiftDate &&
      isLiveShift(other) &&
      timesOverlap(shift, other),
  );
}

/**
 * Validate a manual create or move.
 *
 * `existingForDay` is every stored shift on that calendar day (all sites, all
 * statuses) so the double-booking check sees the whole day rather than one site's
 * corner of it. `absences` is that person's absence, or the practice's; either
 * works, since the rule filters by staff id.
 */
export function validateShiftEdit(
  input: ShiftEditInput,
  existingForDay: RotaShift[],
  absences: Absence[],
  now: Date,
): EditValidation {
  const issues: EditIssue[] = [];

  if (!input.staffId) {
    issues.push({ level: "error", code: "missing-field", message: "Choose who is working the shift." });
  }
  if (!input.siteId) {
    issues.push({ level: "error", code: "missing-field", message: "Choose which site the shift is at." });
  }
  if (!input.role) {
    issues.push({ level: "error", code: "missing-field", message: "Choose what they are working as." });
  }
  if ((input.note?.length ?? 0) > MAX_NOTE_LENGTH) {
    issues.push({
      level: "error",
      code: "missing-field",
      message: `Keep the note under ${MAX_NOTE_LENGTH} characters.`,
    });
  }
  if (!isDayKey(input.shiftDate)) {
    issues.push({ level: "error", code: "bad-date", message: "Enter a valid date for the shift." });
  }
  if (!isTimeOfDay(input.startTime) || !isTimeOfDay(input.endTime)) {
    issues.push({ level: "error", code: "bad-time", message: "Enter a valid start and finish time." });
  } else if (input.endTime <= input.startTime) {
    issues.push({
      level: "error",
      code: "end-before-start",
      message: "The finish time must be after the start time.",
    });
  }
  if (input.pairedStaffId && input.pairedStaffId === input.staffId) {
    issues.push({
      level: "error",
      code: "paired-with-self",
      message: "Somebody cannot be paired with themselves.",
    });
  }

  // Everything below needs a well-formed date and times to mean anything.
  const wellFormed =
    isDayKey(input.shiftDate) &&
    isTimeOfDay(input.startTime) &&
    isTimeOfDay(input.endTime) &&
    input.endTime > input.startTime;

  if (wellFormed && input.staffId) {
    if (wouldDoubleBook(input, existingForDay)) {
      issues.push({
        level: "error",
        code: "double-booked",
        message: "That person is already working at that time, so they cannot take this shift too.",
      });
    }

    // WARNING, not a refusal, and deliberately. Somebody is off, the practice is
    // short, and the manager is asking them to come in anyway. That happens, it
    // needs recording, and the rota is where it should be recorded.
    if (absenceBlocksShift({ staffId: input.staffId, shiftDate: input.shiftDate }, absences)) {
      issues.push({
        level: "warning",
        code: "on-approved-absence",
        message: "That person has agreed time off on that day. Add the shift only if they have agreed to work it.",
      });
    }

    // Also a warning: correcting last week's rota after the fact is a legitimate
    // thing to do, and it is the only way the record can ever be made accurate.
    if (input.shiftDate < londonDayKey(now)) {
      issues.push({
        level: "warning",
        code: "past-day",
        message: "That day has already passed, so nobody will be told about this shift.",
      });
    }
  }

  return { ok: !issues.some((i) => i.level === "error"), issues };
}

/**
 * What a shift's `origin` becomes after a person edits it.
 *
 * Always `manual`, including when the row being edited was generated. This is the
 * rule that makes an edit STICK: a moved generated shift that stayed `generated`
 * would be re-derived from the config and moved straight back on the next run,
 * which is precisely the failure this whole change exists to remove. Once a human
 * has touched a shift, the machine stops having an opinion about it.
 */
export function originAfterEdit(): RotaShiftOrigin {
  return "manual";
}

/** The fields whose change means the staff member was told something that is now wrong. */
const TOLD_FIELDS = ["staffId", "siteId", "shiftDate", "startTime", "endTime"] as const;

/**
 * Whether an edit invalidates what the staff member was already told.
 *
 * A shift marked `notified` is never texted again, which is right: nobody wants the
 * same rota three times. But a shift that MOVED after being texted is a shift
 * somebody will turn up for at the old time, and leaving it marked notified means
 * the correction is never sent. So a move resets the notification, and a change to
 * the note or the pairing does not: those are worth recording and not worth a text
 * at two in the morning.
 */
export function notificationIsStale(
  before: Pick<RotaShift, "staffId" | "siteId" | "shiftDate" | "startTime" | "endTime">,
  after: Pick<ShiftEditInput, "staffId" | "siteId" | "shiftDate" | "startTime" | "endTime">,
): boolean {
  return TOLD_FIELDS.some((f) => before[f] !== after[f]);
}

/** A pairing on a day that does not hold up. */
export interface PairingViolation {
  /** The shift carrying the broken pairing. */
  shiftId: string;
  staffId: string;
  code: "partner-not-working" | "partner-at-another-site" | "pairing-not-mutual" | "unpaired";
  message: string;
}

/**
 * Every pairing problem on one day.
 *
 * Judged against `config.pairRoles`, so a practice that does not work in pairs
 * (`pairRoles: null`) gets no violations at all rather than a screen full of advice
 * about a way of working it does not use.
 *
 * `unpaired` is reported ONLY for the clinical role, and only when the practice
 * actually rosters the support role. A dentist with no nurse is worth flagging; a
 * nurse with no dentist is usually a nurse covering decontamination, and flagging it
 * would train the manager to ignore this list.
 */
export function pairingViolations(dayShifts: RotaShift[], config: RotaConfig): PairingViolation[] {
  const pair = resolvePairRoles(config);
  if (!pair) return [];

  const live = dayShifts.filter(isLiveShift);
  const byStaff = new Map<string, RotaShift>();
  for (const shift of live) if (!byStaff.has(shift.staffId)) byStaff.set(shift.staffId, shift);

  const out: PairingViolation[] = [];
  const rostersSupport = live.some((s) => s.role === pair.support);

  for (const shift of live) {
    if (!shift.id) continue; // an unsaved row has nothing to point at
    const partnerId = shift.pairedStaffId ?? null;

    if (!partnerId) {
      if (shift.role === pair.clinical && rostersSupport) {
        out.push({
          shiftId: shift.id,
          staffId: shift.staffId,
          code: "unpaired",
          message: "Nobody is paired with this shift.",
        });
      }
      continue;
    }

    const partner = byStaff.get(partnerId);
    if (!partner) {
      out.push({
        shiftId: shift.id,
        staffId: shift.staffId,
        code: "partner-not-working",
        message: "The person paired with this shift is not working that day.",
      });
      continue;
    }
    if (partner.siteId !== shift.siteId) {
      out.push({
        shiftId: shift.id,
        staffId: shift.staffId,
        code: "partner-at-another-site",
        message: "The person paired with this shift is at another site that day.",
      });
      continue;
    }
    // A one-way pairing means one of the two screens is telling somebody the wrong
    // thing about who they are working with, and there is no way to know which.
    if ((partner.pairedStaffId ?? null) !== shift.staffId) {
      out.push({
        shiftId: shift.id,
        staffId: shift.staffId,
        code: "pairing-not-mutual",
        message: "This pairing only points one way, so the two shifts disagree about it.",
      });
    }
  }

  return out;
}
