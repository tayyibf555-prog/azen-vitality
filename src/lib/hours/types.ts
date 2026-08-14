import type { ClockAnomalyNote } from "@/lib/clock/types";

// ---------------------------------------------------------------------------
// The month's hours: the shapes.
//
// MONEY IS INTEGER PENCE, EVERYWHERE IN THIS LANE. Never pounds, never a float.
// An hourly rate multiplied by minutes is exactly where binary floating point
// shows up, and a payroll figure that is a penny out is a figure nobody trusts
// again.
//
// The cost fields are OPTIONAL, and that is load bearing. A caller without pay
// access does not receive them set to null or zero: the keys are absent from the
// object the server builds, so there is nothing to leak in the JSON and nothing
// for a component to accidentally render. See src/lib/hr/access.ts.
// ---------------------------------------------------------------------------

/** One effective-dated hourly rate. Appended, never updated (0075). */
export interface PayRate {
  staffId: string;
  /** Pence per hour. Integer. */
  hourlyPence: number;
  /** London day this rate starts applying, inclusive. */
  effectiveFrom: string;
  /** Last day it applies, inclusive, or null for open ended. */
  effectiveTo: string | null;
  note?: string | null;
}

/** The staff fields the report needs. A `RotaStaff` satisfies it structurally. */
export interface HoursStaff {
  id: string;
  name: string;
  role: string;
  siteId: string | null;
}

/** One person's month. */
export interface StaffMonthRow {
  staffId: string;
  name: string;
  role: string;
  siteId: string | null;
  /** Sessions that started in this month, closed or not. */
  sessions: number;
  /** Minutes across CLOSED sessions only. An unresolved session adds nothing. */
  closedMinutes: number;
  /** Sessions still open, or unresolved (a missed clock-out). Each needs a human. */
  openOrUnresolvedCount: number;
  /** Distinct London days with at least one closed session. */
  daysWorked: number;

  // --- pay access only; ABSENT (not null) without it -------------------------
  /** The rate in force on the last day worked, for display. */
  ratePence?: number | null;
  /**
   * Cost of the closed minutes, priced day by day.
   *
   * NULL, never 0, when any worked day has no rate in force: zero is a claim
   * that the work cost nothing, and null is the absence of a claim.
   */
  costPence?: number | null;
  /** Worked days with no rate in force. Non-zero forces `costPence` to null. */
  unpricedDays?: number;
  /** How many distinct rates priced this month. Above 1 means a mid-month change. */
  ratesApplied?: number;
}

export interface MonthTotals {
  staff: number;
  closedMinutes: number;
  openOrUnresolvedCount: number;
  /** Absent without pay access; null when any person could not be priced. */
  costPence?: number | null;
}

export interface MonthReport {
  /** `YYYY-MM`. */
  month: string;
  /** Inclusive London day bounds of the month. */
  from: string;
  to: string;
  rows: StaffMonthRow[];
  totals: MonthTotals;
  /** Everything a human is asked to look at, already worded. */
  unresolved: ClockAnomalyNote[];
  /**
   * Whether this month may be marked final.
   *
   * False whenever anything is unresolved, the read was truncated, or the
   * clocking table is not there. `blockers` says which, in words the page shows.
   */
  finalisable: boolean;
  blockers: string[];
  /** False when migration 0068 is unapplied: say so, never render an empty month. */
  ready: boolean;
  /** True when the paged read hit its ceiling and rows may be missing. */
  truncated: boolean;
  /** Whether cost fields are present at all. */
  includesCost: boolean;
}
