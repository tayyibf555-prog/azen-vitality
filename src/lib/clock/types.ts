// ---------------------------------------------------------------------------
// Staff clocking in and out: the shapes.
//
// The stored record is an append-only EVENT (a tap), never a mutable "worked
// shift" row. Everything a human reads (a session, its length, whether anybody
// forgot to clock out) is DERIVED from those events by src/lib/clock/pairing.ts,
// so a missed clock-out surfaces as a visible exception instead of silently
// corrupting a row. See supabase/migrations/0068_staff_clock.sql.
// ---------------------------------------------------------------------------

/** A tap: arriving or leaving. */
export type ClockKind = "in" | "out";

/**
 * How the event reached us.
 * - manual: the staff member pressed the button in the platform (self-service).
 * - admin:  the practice manager recorded it on somebody else's behalf.
 * - nfc:    a tap on the NTAG 424 DNA tag at the practice. NOTHING writes this
 *           yet; it is in the enum from day one so the tag path is a later
 *           addition rather than a migration.
 * - kiosk:  a shared device at reception. Also not built yet.
 */
export type ClockSource = "manual" | "nfc" | "kiosk" | "admin";

/** One recorded clock event. Append-only: never updated, never deleted. */
export interface ClockEvent {
  id?: string;
  clientId: string;
  siteId: string;
  staffId: string;
  kind: ClockKind;
  /** The instant of the tap, ISO 8601. */
  occurredAt: string;
  source: ClockSource;
  /** The login that pressed the button, which for an admin event is not staffId. */
  recordedBy?: string | null;
  note?: string | null;
  createdAt?: string;
}

/**
 * Why a derived session needs a human to look at it. null means nothing odd.
 *
 * - never-clocked-out: a clock-in was superseded by ANOTHER clock-in with no
 *   clock-out between them. The person definitely forgot; we cannot know when
 *   they left, so minutes stays null.
 * - over-max-length: the session is longer than any plausible working day
 *   (MAX_SESSION_MINUTES). Flagged, never truncated: silently capping it would
 *   invent a leaving time nobody recorded.
 */
export type SessionAnomaly = "never-clocked-out" | "over-max-length";

/** A derived working session: one clock-in, and the clock-out that closed it. */
export interface ClockSession {
  staffId: string;
  siteId: string;
  /** ISO instant of the clock-in that opened this session. */
  inAt: string;
  /** ISO instant of the clock-out, or null when there is not one. */
  outAt: string | null;
  /**
   * Whole minutes between in and out, or null when the session is unresolved.
   *
   * NEVER 0 for an unresolved session. 0 is a claim ("they worked no time");
   * null is the absence of a claim. Matches the house convention in
   * src/lib/perio/*, where an unrecorded measurement is absent, not zero.
   */
  minutes: number | null;
  /** True only while somebody is still clocked in: they are here right now. */
  open: boolean;
  anomaly: SessionAnomaly | null;
}

/**
 * The subset of a rota shift the clocking rules need, so this module does not
 * depend on the rota's internals. A `RotaShift` satisfies it structurally.
 */
export interface RosteredShift {
  id?: string;
  staffId: string;
  siteId: string;
  /** London calendar day, `YYYY-MM-DD`. */
  shiftDate: string;
  /** Wall-clock `HH:MM` (seconds tolerated). */
  startTime: string;
  endTime: string;
  /** 'cancelled' shifts expect nobody, so they neither miss nor roster. */
  status?: string;
}

/** Everything the practice manager is asked to look at, one note per finding. */
export type AnomalyKind =
  | "never-clocked-out"
  | "over-max-length"
  | "no-rostered-shift"
  | "early-start"
  | "missing-clock-in";

/** A single quiet exception. `at` anchors it to the session or shift it came from. */
export interface ClockAnomalyNote {
  kind: AnomalyKind;
  staffId: string;
  /** Ready-to-render copy. Quiet and factual: this raises, it does not accuse. */
  label: string;
  /** ISO instant the note points at, or null when the finding has no instant. */
  at: string | null;
}

/** The answer to "may this tap be recorded?". */
export type ClockValidation = { ok: true } | { ok: false; reason: string };

/** Where one staff member stands today. */
export type TodayState =
  /** Clocked in right now. */
  | "in"
  /** Clocked in earlier and clocked out again. */
  | "out"
  /** Rostered today but has not clocked in yet. */
  | "expected"
  /** Neither rostered nor clocked in today. */
  | "off";

/** The staff fields the today view needs. Kept minimal on purpose. */
export interface ClockStaff {
  id: string;
  name: string;
  role: string;
  siteId: string | null;
}

/** One row of the today view: computed here, rendered verbatim by the component. */
export interface TodayRow {
  staffId: string;
  name: string;
  role: string;
  siteId: string | null;
  state: TodayState;
  /** The only tap that makes sense for this person next. */
  nextKind: ClockKind;
  sessions: ClockSession[];
  shifts: RosteredShift[];
  /** Minutes across CLOSED sessions today, or null when none has closed yet. */
  minutes: number | null;
  /** Minutes elapsed on the open session, or null when they are not clocked in. */
  openMinutes: number | null;
  /** ISO instant they clocked in, while they are still in. */
  since: string | null;
  /** The exceptions for this person, already worded. */
  notes: ClockAnomalyNote[];
}

/** The whole today view: rows plus the counts the header shows. */
export interface TodayView {
  /** The London day this view describes, `YYYY-MM-DD`. */
  dayKey: string;
  rows: TodayRow[];
  inNow: number;
  expected: number;
  clockedOut: number;
  /** Every exception across every row, for the manager's list. */
  notes: ClockAnomalyNote[];
}
