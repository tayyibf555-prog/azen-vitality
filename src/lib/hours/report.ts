import { detectAnomalies, pairEvents } from "@/lib/clock/pairing";
import { londonDayKey } from "@/lib/time/london";
import { priceDays, type DayMinutes } from "./cost";
import type { ClockEvent, ClockSession, RosteredShift } from "@/lib/clock/types";
import type { HoursStaff, MonthReport, MonthTotals, PayRate, StaffMonthRow } from "./types";

// ===========================================================================
// THE MONTH'S HOURS.
//
// Everything the Hours screen shows is decided here: the per-person totals, what
// they cost, what is unresolved, and whether the month may be called final. The
// component renders it and holds no rule of its own.
//
// THE PAYROLL BOUNDARY, STATED ONCE AND SHOWN ON THE PAGE. This is hours and
// cost. It is not payroll: nothing here is submitted to HMRC, no RTI, no
// payslips, no deductions, no pension, no statutory pay. It is the number a
// practice reads to a bookkeeper, and it says so where a manager can see it.
//
// THREE THINGS IT REFUSES TO DO, EACH BECAUSE THE HONEST ANSWER IS UNCOMFORTABLE:
//   * an unresolved session contributes NOTHING, and is listed. A missed
//     clock-out has no length; guessing one invents hours nobody worked.
//   * a person with no rate costs NULL, never 0.
//   * a truncated read, or a month that has not ended, cannot be marked final.
//
// PURE: no I/O, no Date.now(). `now` is a parameter, so a month can be tested at
// any point in its life.
// ===========================================================================

const DAY_MS = 86_400_000;
const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface MonthReportInput {
  /** The people the caller may see, already site-scoped by the route. */
  staff: HoursStaff[];
  /**
   * Clock events covering the month PLUS a day of margin each side, so a session
   * that runs past midnight on the last of the month is still paired with the
   * clock-out that closed it. Sessions are then attributed to the month by their
   * clock-IN day, so the margin cannot double-count.
   */
  events: ClockEvent[];
  /** Rota shifts inside the month, for the "rostered but never clocked in" check. */
  shifts: RosteredShift[];
  /** Every pay rate for these staff. Ignored entirely unless `includeCost`. */
  rates?: readonly PayRate[];
  /** `YYYY-MM`. */
  month: string;
  now: Date;
  /** False when migration 0068 is unapplied: the page says so out loud. */
  ready?: boolean;
  /** True when the paged read hit its ceiling; rows may be missing. */
  truncated?: boolean;
  /**
   * Whether to compute cost at all.
   *
   * FALSE OMITS THE KEYS ENTIRELY — it does not set them to null. A caller
   * without `hr.view-pay` receives objects with no cost fields on them, so there
   * is nothing in the JSON to leak and nothing for a component to render by
   * accident. See src/lib/hr/access.ts.
   */
  includeCost?: boolean;
}

/** Inclusive London day bounds of a `YYYY-MM` month, or null if it is not one. */
export function monthBounds(month: string): { from: string; to: string } | null {
  if (!MONTH_KEY.test(month)) return null;
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const from = `${month}-01`;
  const to = new Date(Date.UTC(year, m, 1) - DAY_MS).toISOString().slice(0, 10);
  return { from, to };
}

/** The `YYYY-MM` a London day belongs to. */
export function monthOfDay(dayKey: string): string {
  return dayKey.slice(0, 7);
}

/** The current London month, `YYYY-MM`. */
export function currentMonth(now: Date): string {
  return monthOfDay(londonDayKey(now));
}

/** The London day a session belongs to: the day it STARTED. */
function sessionDay(session: ClockSession): string {
  return londonDayKey(new Date(session.inAt));
}

/** A session nobody can total: still open, or unresolved. */
function needsADecision(session: ClockSession): boolean {
  return session.open || session.minutes === null || session.anomaly !== null;
}

function emptyReport(input: MonthReportInput, blockers: string[]): MonthReport {
  const bounds = monthBounds(input.month) ?? { from: "", to: "" };
  const totals: MonthTotals = { staff: 0, closedMinutes: 0, openOrUnresolvedCount: 0 };
  if (input.includeCost) totals.costPence = null;
  return {
    month: input.month,
    from: bounds.from,
    to: bounds.to,
    rows: [],
    totals,
    unresolved: [],
    finalisable: false,
    blockers,
    ready: input.ready !== false,
    truncated: Boolean(input.truncated),
    includesCost: Boolean(input.includeCost),
  };
}

/**
 * Build the whole month, as data.
 *
 * Never throws on bad input: an unreadable month or an unavailable table comes
 * back as a report that SAYS it could not be read, because a screen showing a
 * confident empty month is the one outcome worse than an error.
 */
export function buildMonthReport(input: MonthReportInput): MonthReport {
  const bounds = monthBounds(input.month);
  if (!bounds) return emptyReport(input, ["That month could not be read."]);

  const ready = input.ready !== false;
  const truncated = Boolean(input.truncated);
  const includeCost = Boolean(input.includeCost);

  if (!ready) {
    return emptyReport(input, ["Clocking is not switched on for this practice yet."]);
  }

  const { from, to } = bounds;
  const inMonth = (dayKey: string) => dayKey >= from && dayKey <= to;

  // Pair the whole stream (margin included), then attribute by the clock-IN day.
  const sessions = pairEvents(input.events, input.now).filter((s) => inMonth(sessionDay(s)));
  const shifts = input.shifts.filter((s) => inMonth(s.shiftDate));

  const staffIds = new Set(input.staff.map((s) => s.id));
  const notes = detectAnomalies(sessions, shifts, input.now).filter((n) => staffIds.has(n.staffId));

  const ratesByStaff = new Map<string, PayRate[]>();
  if (includeCost) {
    for (const rate of input.rates ?? []) {
      const list = ratesByStaff.get(rate.staffId);
      if (list) list.push(rate);
      else ratesByStaff.set(rate.staffId, [rate]);
    }
  }

  const rows: StaffMonthRow[] = input.staff.map((person) => {
    const mine = sessions.filter((s) => s.staffId === person.id);

    // Minutes per DAY, because pricing is per day. Only closed sessions count:
    // `minutes` is null for anything unresolved, and null is not zero.
    const minutesByDay = new Map<string, number>();
    for (const session of mine) {
      if (session.minutes === null) continue;
      const day = sessionDay(session);
      minutesByDay.set(day, (minutesByDay.get(day) ?? 0) + session.minutes);
    }
    const days: DayMinutes[] = [...minutesByDay.entries()].map(([dayKey, minutes]) => ({ dayKey, minutes }));
    const closedMinutes = days.reduce((total, d) => total + d.minutes, 0);

    const row: StaffMonthRow = {
      staffId: person.id,
      name: person.name,
      role: person.role,
      siteId: person.siteId,
      sessions: mine.length,
      closedMinutes,
      openOrUnresolvedCount: mine.filter(needsADecision).length,
      daysWorked: days.filter((d) => d.minutes > 0).length,
    };

    // The keys are only ever CREATED when the caller may see them.
    if (includeCost) {
      const priced = priceDays(days, ratesByStaff.get(person.id) ?? []);
      row.costPence = priced.costPence;
      row.ratePence = priced.lastRatePence;
      row.unpricedDays = priced.unpricedDays;
      row.ratesApplied = priced.ratesApplied;
    }

    return row;
  });

  const totals: MonthTotals = {
    staff: rows.length,
    closedMinutes: rows.reduce((t, r) => t + r.closedMinutes, 0),
    openOrUnresolvedCount: rows.reduce((t, r) => t + r.openOrUnresolvedCount, 0),
  };
  if (includeCost) {
    // A total that quietly omits the people we could not price is a total that
    // understates the month. Null says "not every person could be priced".
    const anyUnpriced = rows.some((r) => r.costPence === null || r.costPence === undefined);
    totals.costPence = anyUnpriced ? null : rows.reduce((t, r) => t + (r.costPence ?? 0), 0);
  }

  const today = londonDayKey(input.now);
  const blockers: string[] = [];
  if (truncated) {
    blockers.push(
      "This month has more clock events than one read returns, so the figures may be short. Narrow the site or the month.",
    );
  }
  if (today <= to) {
    blockers.push("The month has not finished yet.");
  }
  if (notes.length > 0) {
    blockers.push(
      `${notes.length} ${notes.length === 1 ? "entry needs" : "entries need"} a decision before the month can be marked final.`,
    );
  }

  return {
    month: input.month,
    from,
    to,
    rows,
    totals,
    unresolved: notes,
    finalisable: blockers.length === 0,
    blockers,
    ready,
    truncated,
    includesCost: includeCost,
  };
}
