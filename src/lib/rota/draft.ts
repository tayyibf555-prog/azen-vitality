// ---------------------------------------------------------------------------
// Pure staff-shift SMS builder.
//
// Templated (not model-generated): the exact dates and times must be correct, so
// we never risk an LLM paraphrasing a shift. British English, no dash characters.
// Staff are employees, so no patient-safe funding language concerns apply, but we
// keep the copy plain and under about four lines.
// ---------------------------------------------------------------------------

export interface ShiftLine {
  /** London calendar day, `YYYY-MM-DD`. */
  date: string;
  /** Wall-clock `HH:MM`. */
  start: string;
  end: string;
  siteName: string;
}

/** First name only, for a friendly greeting. Falls back to "there". */
function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] || "there";
}

/** "Mon 1 Jul" from a `YYYY-MM-DD` day key, London locale. */
function dayLabel(dateKey: string): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateKey;
  return d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "Europe/London",
  });
}

/**
 * A friendly SMS listing a staff member's upcoming shifts, e.g.
 *   "Hi Sam, your shifts at Vitality Dental: Mon 1 Jul 09:00 to 17:30 City Centre;
 *    Tue 2 Jul 09:00 to 17:30 Riverside. Thanks."
 * Kept to a compact single block, under about four lines. If there are no shifts,
 * returns a short "nothing scheduled" note so the caller never sends an empty body.
 */
export function draftShiftMessage(
  staffName: string,
  practiceName: string,
  shifts: ShiftLine[],
): string {
  const first = firstName(staffName);
  if (shifts.length === 0) {
    return `Hi ${first}, you have no shifts scheduled at ${practiceName} at the moment. We will let you know when your next ones are booked. Thanks.`;
  }
  const lines = shifts
    .map((s) => `${dayLabel(s.date)} ${s.start} to ${s.end} ${s.siteName}`)
    .join("; ");
  return `Hi ${first}, your upcoming shifts at ${practiceName}: ${lines}. Please let us know if you cannot make any of these. Thanks.`;
}

/**
 * The message for somebody whose week has been EMPTIED since the last publication:
 * every shift they had that week was deleted, cancelled or given to someone else.
 *
 * Deliberately NOT `draftShiftMessage(..., [])`. That copy says "no shifts at the
 * moment", which reads as a general state of affairs; this person had a specific
 * week and needs to be told about that week, by name, so they do not turn up.
 * It says what changed and it names the week, and it does not speculate about why.
 */
export function draftClearedWeekMessage(
  staffName: string,
  practiceName: string,
  weekStart: string,
): string {
  const first = firstName(staffName);
  return `Hi ${first}, your rota at ${practiceName} for the week beginning ${dayLabel(weekStart)} has changed and you are no longer down to work that week. Please check with the practice if you were expecting to be in. Thanks.`;
}
