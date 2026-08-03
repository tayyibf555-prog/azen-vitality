import { londonDayKey } from "@/lib/time/london";
import { londonInstantMs } from "@/lib/calendar/availability";
import type {
  ClockAnomalyNote,
  ClockEvent,
  ClockKind,
  ClockSession,
  ClockStaff,
  ClockValidation,
  RosteredShift,
  SessionAnomaly,
  TodayRow,
  TodayState,
  TodayView,
} from "./types";

// ===========================================================================
// PAIRING: turning taps into sessions.
//
// The database stores events, not sessions (0068_staff_clock.sql). Everything a
// human reads is derived here, and every function is PURE: no Date.now(), no
// I/O, `now` is always a parameter. That is not a style preference in this
// repo. Five defects have come from a rule living inside a React closure where
// nothing could test it, and a clocking rule that reads the wall clock itself
// can only be tested on the day it happens to be right.
//
// The one invariant worth stating twice: an unresolved session has
// `minutes: null`, NEVER 0. Zero means "they worked no time", which is a claim
// about the person. Null means we do not know, which is the truth.
// ===========================================================================

const MS_PER_MINUTE = 60_000;

/**
 * Longer than this and a session stops being a working day and starts being a
 * missed clock-out. 14 hours clears the longest plausible practice day
 * (an 08:00 open with a late list and a clear-down) without excusing an
 * overnight session nobody noticed.
 */
export const MAX_SESSION_MINUTES = 14 * 60;

/**
 * Clocking in this far before the rostered start is worth a quiet note. Early
 * is not wrong (somebody opening up, or covering) but it is the shape of a tap
 * recorded on the wrong day or against the wrong person, so it is raised.
 */
export const EARLY_CLOCK_IN_MINUTES = 45;

// ---------------------------------------------------------------------------
// Small pure helpers.
// ---------------------------------------------------------------------------

const LONDON_CLOCK = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** The Europe/London wall clock of an instant, as "HH:MM". "" when unparseable. */
export function londonTimeLabel(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  // Some ICU builds render midnight as "24:00"; normalise it.
  const raw = LONDON_CLOCK.format(new Date(ms));
  return raw.startsWith("24:") ? `00:${raw.slice(3)}` : raw;
}

/** "8h 12m", "45m", "0m". Whole minutes only, no seconds anywhere. */
export function durationLabel(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours === 0) return `${mins}m`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

/** Parse a rota "HH:MM" or "HH:MM:SS" wall clock. null when it is not one. */
function parseHhMm(value: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** The instant a rostered shift starts, or NaN when its time cannot be read. */
function shiftStartMs(shift: RosteredShift): number {
  const t = parseHhMm(shift.startTime);
  if (!t) return NaN;
  return londonInstantMs(shift.shiftDate, t.hour, t.minute);
}

/** A shift that expects somebody. Cancelled shifts roster nobody. */
function isRostered(shift: RosteredShift): boolean {
  return shift.status !== "cancelled";
}

/** Whole minutes between two instants, floored at 0 so a skewed clock cannot go negative. */
function minutesBetween(fromMs: number, toMs: number): number {
  return Math.max(0, Math.round((toMs - fromMs) / MS_PER_MINUTE));
}

// ---------------------------------------------------------------------------
// Sorting and pairing.
// ---------------------------------------------------------------------------

/**
 * Chronological order, with a deterministic tiebreak so the same input always
 * pairs the same way: same instant means the arrival is read before the
 * departure ("in" < "out"), then by id.
 */
function chronological(a: ClockEvent, b: ClockEvent): number {
  const at = Date.parse(a.occurredAt);
  const bt = Date.parse(b.occurredAt);
  if (at !== bt) return at - bt;
  if (a.kind !== b.kind) return a.kind === "in" ? -1 : 1;
  return (a.id ?? "").localeCompare(b.id ?? "");
}

/** Events with a readable timestamp, in order. An unreadable one is dropped, not guessed. */
function sortedEvents(events: ClockEvent[]): ClockEvent[] {
  return events.filter((e) => !Number.isNaN(Date.parse(e.occurredAt))).sort(chronological);
}

/** One staff member's stream, paired. `events` must already be sorted. */
function pairOneStream(events: ClockEvent[], now: Date): ClockSession[] {
  const sessions: ClockSession[] = [];
  let openIndex = -1;

  for (const event of events) {
    if (event.kind === "in") {
      // A second clock-in with no clock-out between them: the earlier session is
      // NOT dropped and NOT closed at a guessed time. It is kept, unresolved, and
      // marked, because the practice manager needs to see that it happened.
      if (openIndex >= 0) {
        sessions[openIndex].open = false;
        sessions[openIndex].anomaly = "never-clocked-out";
      }
      sessions.push({
        staffId: event.staffId,
        siteId: event.siteId,
        inAt: event.occurredAt,
        outAt: null,
        minutes: null,
        open: true,
        anomaly: null,
      });
      openIndex = sessions.length - 1;
      continue;
    }

    // kind === "out". With no open session there is nothing to close: the tap is
    // an orphan (validateClock refuses these, so it can only reach us from an
    // admin correction or a direct insert). Ignoring it is right; inventing a
    // session that starts at the clock-out is not.
    if (openIndex < 0) continue;
    const session = sessions[openIndex];
    const minutes = minutesBetween(Date.parse(session.inAt), Date.parse(event.occurredAt));
    session.outAt = event.occurredAt;
    session.minutes = minutes;
    session.open = false;
    session.anomaly = minutes > MAX_SESSION_MINUTES ? "over-max-length" : null;
    openIndex = -1;
  }

  // A session still open at the end of the stream is somebody who is HERE, so it
  // is not an exception on its own. It only becomes one once it has run longer
  // than any working day, which is what a forgotten clock-out looks like.
  if (openIndex >= 0) {
    const session = sessions[openIndex];
    const elapsed = minutesBetween(Date.parse(session.inAt), now.getTime());
    if (elapsed > MAX_SESSION_MINUTES) session.anomaly = "over-max-length";
  }

  return sessions;
}

/**
 * Pair a set of clock events into sessions.
 *
 * Events may arrive in any order (the API reads them by index, a manager may
 * record a correction after the fact) so they are sorted first. Events for more
 * than one staff member are grouped per person before pairing, so a day's worth
 * of a whole practice's taps can be passed in without one person's clock-out
 * closing another person's session.
 *
 * Output is ordered by clock-in time, then staff id, so a manager's list reads
 * as the day happened.
 */
export function pairEvents(events: ClockEvent[], now: Date): ClockSession[] {
  const byStaff = new Map<string, ClockEvent[]>();
  for (const event of sortedEvents(events)) {
    const list = byStaff.get(event.staffId);
    if (list) list.push(event);
    else byStaff.set(event.staffId, [event]);
  }

  const sessions: ClockSession[] = [];
  for (const stream of byStaff.values()) sessions.push(...pairOneStream(stream, now));

  return sessions.sort(
    (a, b) => Date.parse(a.inAt) - Date.parse(b.inAt) || a.staffId.localeCompare(b.staffId),
  );
}

/**
 * The only tap that makes sense next for ONE staff member.
 *
 * Pass a single person's events. Empty history, or a history ending in a
 * clock-out, means the next tap is a clock-in.
 */
export function nextValidKind(events: ClockEvent[]): ClockKind {
  const sorted = sortedEvents(events);
  const last = sorted[sorted.length - 1];
  return last?.kind === "in" ? "out" : "in";
}

/**
 * Whether a tap may be recorded, checked SERVER SIDE on every write.
 *
 * Refuses the three things that corrupt the log: a tap in the future, a second
 * clock-in while one is already open, and a clock-out with nothing open. The
 * button in the UI already shows only the valid action, but a button is a
 * suggestion and this is the rule.
 */
export function validateClock(
  events: ClockEvent[],
  kind: ClockKind,
  at: Date,
  now: Date,
): ClockValidation {
  const atMs = at.getTime();
  if (Number.isNaN(atMs)) return { ok: false, reason: "That time could not be read." };
  if (atMs > now.getTime()) {
    return { ok: false, reason: "A clock event cannot be in the future." };
  }

  const expected = nextValidKind(events);
  if (kind === expected) return { ok: true };

  return kind === "in"
    ? { ok: false, reason: "Already clocked in. Clock out first." }
    : { ok: false, reason: "Not clocked in, so there is nothing to clock out of." };
}

// ---------------------------------------------------------------------------
// Totals and the rota comparison.
// ---------------------------------------------------------------------------

/**
 * Minutes across the sessions that have actually closed.
 *
 * Open and unresolved sessions contribute nothing, because their length is not
 * known. A caller that wants to distinguish "no time worked" from "nothing
 * closed yet" should check the sessions, not this number.
 */
export function minutesWorked(sessions: ClockSession[]): number {
  return sessions.reduce((total, s) => total + (s.minutes ?? 0), 0);
}

/** What the clock says versus what the rota said. */
export interface RotaComparison {
  /** Sessions on a day where that person was not rostered at all. */
  unrostered: ClockSession[];
  /** Rostered shifts where that person never clocked in. */
  missed: RosteredShift[];
}

/**
 * Compare derived sessions against the rota, on staff member and calendar day.
 *
 * Deliberately time agnostic: it answers "did the clock and the rota agree",
 * not "should they have agreed by now". detectAnomalies applies `now` to decide
 * which disagreements are worth raising yet, so a 14:00 shift is not a missed
 * clock-in at nine in the morning.
 *
 * Cancelled shifts are ignored on both sides: they expect nobody, so they can
 * neither be missed nor make a session rostered.
 */
export function compareToRota(sessions: ClockSession[], shifts: RosteredShift[]): RotaComparison {
  const rostered = shifts.filter(isRostered);
  const key = (staffId: string, dayKey: string) => `${staffId}|${dayKey}`;

  const shiftDays = new Set(rostered.map((s) => key(s.staffId, s.shiftDate)));
  const sessionDays = new Set(
    sessions.map((s) => key(s.staffId, londonDayKey(new Date(s.inAt)))),
  );

  return {
    unrostered: sessions.filter(
      (s) => !shiftDays.has(key(s.staffId, londonDayKey(new Date(s.inAt)))),
    ),
    missed: rostered.filter((s) => !sessionDays.has(key(s.staffId, s.shiftDate))),
  };
}

// ---------------------------------------------------------------------------
// Exceptions.
// ---------------------------------------------------------------------------

const ANOMALY_LABEL: Record<SessionAnomaly, (session: ClockSession, elapsed: number) => string> = {
  "never-clocked-out": (session) =>
    `Clocked in at ${londonTimeLabel(session.inAt)} but never clocked out.`,
  "over-max-length": (session, elapsed) =>
    session.open
      ? `Clocked in at ${londonTimeLabel(session.inAt)} and still clocked in ${durationLabel(elapsed)} later.`
      : `Session ran ${durationLabel(session.minutes ?? 0)}, longer than a working day.`,
};

/**
 * Everything the practice manager is asked to look at, worded and ready to
 * render as quiet chips. Nothing here blocks anybody: attendance exceptions are
 * raised for a human to explain, never enforced against the person.
 *
 * `now` decides which findings have matured. A rostered shift that has not
 * started yet is not a missed clock-in.
 */
export function detectAnomalies(
  sessions: ClockSession[],
  shifts: RosteredShift[],
  now: Date,
): ClockAnomalyNote[] {
  const notes: ClockAnomalyNote[] = [];

  for (const session of sessions) {
    if (!session.anomaly) continue;
    const elapsed = minutesBetween(Date.parse(session.inAt), now.getTime());
    notes.push({
      kind: session.anomaly,
      staffId: session.staffId,
      label: ANOMALY_LABEL[session.anomaly](session, elapsed),
      at: session.inAt,
    });
  }

  const { unrostered, missed } = compareToRota(sessions, shifts);

  for (const session of unrostered) {
    notes.push({
      kind: "no-rostered-shift",
      staffId: session.staffId,
      label: `Clocked in at ${londonTimeLabel(session.inAt)} with no shift on the rota.`,
      at: session.inAt,
    });
  }

  // Clocked in well before the rostered start. Matched per shift so a person with
  // two shifts in a day is measured against the one they turned up for.
  const rostered = shifts.filter(isRostered);
  for (const session of sessions) {
    const inMs = Date.parse(session.inAt);
    const dayKey = londonDayKey(new Date(inMs));
    for (const shift of rostered) {
      if (shift.staffId !== session.staffId || shift.shiftDate !== dayKey) continue;
      const startMs = shiftStartMs(shift);
      if (Number.isNaN(startMs)) continue;
      const early = Math.round((startMs - inMs) / MS_PER_MINUTE);
      if (early <= EARLY_CLOCK_IN_MINUTES) continue;
      notes.push({
        kind: "early-start",
        staffId: session.staffId,
        label: `Clocked in at ${londonTimeLabel(session.inAt)}, ${durationLabel(early)} before the ${shift.startTime.slice(0, 5)} shift.`,
        at: session.inAt,
      });
    }
  }

  for (const shift of missed) {
    const startMs = shiftStartMs(shift);
    // Not started yet, so not yet a miss. An unreadable start time is treated the
    // same way rather than raised as an exception about a shift we cannot read.
    if (Number.isNaN(startMs) || startMs > now.getTime()) continue;
    notes.push({
      kind: "missing-clock-in",
      staffId: shift.staffId,
      label: `Rostered ${shift.startTime.slice(0, 5)} to ${shift.endTime.slice(0, 5)} but has not clocked in.`,
      at: new Date(startMs).toISOString(),
    });
  }

  return notes;
}

// ---------------------------------------------------------------------------
// The today view.
// ---------------------------------------------------------------------------

export interface TodayViewInput {
  staff: ClockStaff[];
  /** Every clock event for the day being shown, any staff member, any order. */
  events: ClockEvent[];
  /** Every rota shift for the same day. */
  shifts: RosteredShift[];
  now: Date;
  /** The London day to describe. Defaults to the London day of `now`. */
  dayKey?: string;
}

/**
 * Build the whole "today" screen as data.
 *
 * The component that renders this contains no rules at all: every state, count,
 * duration and exception is decided here, where a test can reach it.
 */
export function buildTodayView(input: TodayViewInput): TodayView {
  const dayKey = input.dayKey ?? londonDayKey(input.now);
  const sessions = pairEvents(input.events, input.now);
  const shifts = input.shifts.filter((s) => s.shiftDate === dayKey);
  const notes = detectAnomalies(sessions, shifts, input.now);

  const rows: TodayRow[] = input.staff.map((person) => {
    const mine = sessions.filter((s) => s.staffId === person.id);
    const myShifts = shifts.filter((s) => s.staffId === person.id && isRostered(s));
    const open = mine.find((s) => s.open) ?? null;
    const closed = mine.filter((s) => s.minutes !== null);

    const state: TodayState = open
      ? "in"
      : mine.length > 0
        ? "out"
        : myShifts.length > 0
          ? "expected"
          : "off";

    return {
      staffId: person.id,
      name: person.name,
      role: person.role,
      siteId: person.siteId,
      state,
      // The button's label is a RULE, not a rendering choice, so it is decided
      // here next to the state machine that refuses the wrong tap server side.
      nextKind: open ? "out" : "in",
      sessions: mine,
      shifts: myShifts,
      // Null, not 0, until something has actually closed: "0m" is a claim that
      // they worked no time, which is exactly wrong for somebody mid-shift.
      minutes: closed.length > 0 ? minutesWorked(closed) : null,
      openMinutes: open ? minutesBetween(Date.parse(open.inAt), input.now.getTime()) : null,
      since: open?.inAt ?? null,
      notes: notes.filter((n) => n.staffId === person.id),
    };
  });

  return {
    dayKey,
    rows,
    inNow: rows.filter((r) => r.state === "in").length,
    expected: rows.filter((r) => r.state === "expected").length,
    clockedOut: rows.filter((r) => r.state === "out").length,
    notes,
  };
}
