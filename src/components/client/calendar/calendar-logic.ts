import type { Tone } from "@/components/primitives";
import { londonDayKey } from "@/lib/time/london";

// Pure calendar-board logic, extracted so it is unit-testable: calendar-board.tsx
// is a client component ("use client") and the vitest config collects ONLY
// src/**/*.test.ts (no .tsx, no jsdom), so anything worth testing has to live here.
//
// Covers the calendar's five display defects:
//   B1, appointment times must be Europe/London, never UTC (hhmm).
//   B2, "today" and day-bucketing must be the LONDON calendar day (dayKey).
//   B4, navigation must never land on a day outside the loaded window
//        (clampDayToWindow / isWithinWindow).
//   B5, every appointment state gets its own dot colour and, for the states
//        that need calling out, a StatusPill badge (STATE_DOT / STATE_LABEL /
//        STATE_BADGE_TONE / STATE_BADGE_LABEL).

/**
 * The Europe/London calendar day (YYYY-MM-DD) an appointment's ISO start falls
 * on. MUST be London-aware, never a raw UTC slice: an appointment at 23:30 UTC
 * during BST is 00:30 the NEXT London day, and a UTC slice would silently file
 * it under the wrong day (B2's exact failure mode, just for a booking instead
 * of "today").
 */
export function dayKey(iso: string): string {
  return londonDayKey(new Date(iso));
}

/**
 * The same London calendar day, or null when the instant cannot be parsed.
 *
 * dayKey THROWS on an unparseable value (Intl.DateTimeFormat.format rejects an
 * invalid Date with a RangeError), and toAppointment maps a missing Dentally
 * start_time to "". One such row anywhere in the loaded sixty-day window would
 * otherwise take the whole diary down mid-render. Every other layer already
 * defends this (londonMinutes returns NaN, layoutColumn drops the row,
 * blockTimes returns null), so this is the last unguarded seam. The caller is
 * expected to SURFACE what it could not place rather than drop it quietly.
 */
export function safeDayKey(iso: string): string | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : londonDayKey(d);
}

/**
 * Add/subtract whole days from a YYYY-MM-DD day key. Anchored at UTC midnight
 * so the arithmetic is a pure calendar-day step, never a wall-clock instant. The
 * key itself is already the correct London day (from dayKey/londonDayKey),
 * so stepping it in UTC cannot introduce a DST-shift artefact.
 */
export function shiftDay(dayIso: string, by: number): string {
  const d = new Date(`${dayIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
}

/** The Monday of the week containing this day key. */
export function mondayOf(dayIso: string): string {
  const d = new Date(`${dayIso}T00:00:00Z`);
  const offset = (d.getUTCDay() + 6) % 7; // days since Monday
  return shiftDay(dayIso, -offset);
}

/**
 * Clamp a day key into the loaded [min, max] window (day keys). Used so
 * navigating past the fetched range can never land on a day the app has no
 * data for (B4): without this, paging far enough forward or back shows a day
 * with zero appointments in the array, which looks exactly like a free day
 * even when the real diary is fully booked.
 */
export function clampDayToWindow(day: string, min: string, max: string): string {
  if (day < min) return min;
  if (day > max) return max;
  return day;
}

/** Whether a day key falls within the loaded [min, max] window (inclusive). */
export function isWithinWindow(day: string, min: string, max: string): boolean {
  return day >= min && day <= max;
}

/**
 * A London wall-clock "HH:MM" for an appointment's ISO start. MUST use the
 * Europe/London zone, never UTC (B1): during BST (UTC+1) a UTC-formatted time
 * reads an hour early for every single appointment.
 */
export function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
  });
}

/** "Thursday 2 July 2026" for a day key. Pure calendar-day formatting: the key
 *  is already the correct day, so UTC-midnight avoids any DST-shift artefact. */
export function longDate(dayIso: string): string {
  return new Date(`${dayIso}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** "2 Jul, 8 Jul 2026" for the week containing a day key. */
export function weekLabel(dayIso: string): string {
  const mon = mondayOf(dayIso);
  const sun = shiftDay(mon, 6);
  const fmt = (d: string, opts: Intl.DateTimeFormatOptions) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { ...opts, timeZone: "UTC" });
  return `${fmt(mon, { day: "numeric", month: "short" })}, ${fmt(sun, { day: "numeric", month: "short", year: "numeric" })}`;
}

/** "Thu" for a day key. */
export function dow(dayIso: string): string {
  return new Date(`${dayIso}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });
}

/** The day-of-month number for a day key. */
export function dnum(dayIso: string): number {
  return new Date(`${dayIso}T00:00:00Z`).getUTCDate();
}

// --- Appointment state -> visual encoding (B5) ---------------------------------
//
// Real Dentally appointment states (see normaliseAppointmentState): pending,
// confirmed, arrived, in_surgery, completed, cancelled, did_not_attend; the mock
// also uses the legacy "booked". Previously only booked/completed/did_not_attend/
// cancelled/pending had a dot colour, so confirmed/arrived/in_surgery all fell
// through to the SAME grey default as cancelled, staff could not tell a
// cancelled slot from a patient sitting in the chair. Every state below now has
// its own colour, chosen from tokens that stay distinct in the live theme
// (status-blue and status-royal are the SAME hex there, so both blues used here
// are status-blue and the separate blue-light/navy tokens, not status-royal).
//
// Colour is never the ONLY signal: STATE_LABEL backs a title + sr-only text at
// every call site, and STATE_BADGE_TONE/LABEL surface a StatusPill for the
// states staff most need to notice.

// The mapping is Dentally's own, matching the practice dashboard
// (appointment-list.tsx: "Confirmed reads green and pending amber, as it does in
// Dentally"). Two colours for confirmed across two screens is the inconsistency
// that costs clinician trust, so one state means one colour everywhere:
// confirmed and its legacy stand-in "booked" are green, arrived takes the full
// status-blue (bg-blue-light is a pale sky blue and weak at 7px), and completed
// moves to the muted grey so green cannot mean two things at once.
export const STATE_DOT: Record<string, string> = {
  pending: "bg-status-amber",
  confirmed: "bg-status-green",
  arrived: "bg-status-blue",
  in_surgery: "bg-navy",
  completed: "bg-muted",
  did_not_attend: "bg-status-red",
  cancelled: "bg-line-strong",
  booked: "bg-status-green", // the mock's legacy stand-in for confirmed
};

export const STATE_LABEL: Record<string, string> = {
  pending: "Pending",
  confirmed: "Confirmed",
  arrived: "Arrived",
  in_surgery: "In surgery",
  completed: "Completed",
  did_not_attend: "No-show",
  cancelled: "Cancelled",
  booked: "Booked",
};

/** The dot fill class for a state, falling back to the neutral grey for an
 *  unrecognised value (never silently matching "cancelled"'s colour by luck of
 *  object-key miss, this fallback is explicit and applies to every unknown
 *  state alike). */
export function stateDotClass(state: string): string {
  return STATE_DOT[state] ?? "bg-line-strong";
}

/** The human label for a state, falling back to the raw value. */
export function stateLabel(state: string): string {
  return STATE_LABEL[state] ?? state;
}

// States worth an explicit StatusPill callout in the row's trailing meta column
// (reusing the shared primitive per B5, rather than a hand-rolled tinted span):
// not-yet-confirmed, physically present, or a no-show. The routine progression
// (booked/confirmed/completed) stays quiet with just the duration, and
// "cancelled" keeps its existing plain muted-text treatment.
export const STATE_BADGE_TONE: Partial<Record<string, Tone>> = {
  pending: "warning",
  arrived: "info",
  in_surgery: "info",
  did_not_attend: "danger",
};

export const STATE_BADGE_LABEL: Partial<Record<string, string>> = {
  pending: "Awaiting confirmation",
  arrived: "Arrived",
  in_surgery: "In surgery",
  did_not_attend: "No-show",
};
