import { describe, it, expect } from "vitest";
import {
  DEFAULT_LEAVE_YEAR_START_MONTH,
  STATUTORY_CAP_DAYS,
  daysPerWeekFromAvailability,
  inclusiveDays,
  leaveYearBounds,
  proRataForWindow,
  resolveEntitlement,
  statutoryDays,
} from "./entitlement";
import type { Availability } from "@/lib/rota/types";

const FULL_WEEK: Availability = {
  monday: true,
  tuesday: true,
  wednesday: true,
  thursday: true,
  friday: true,
};

describe("statutoryDays", () => {
  it("a five day week earns 28 days", () => {
    expect(statutoryDays(5)).toBe(28);
  });

  it("a three day week earns 16.8 days, not 16.799999999999997", () => {
    // The float trap: 3 * 5.6 is 16.799999999999997 in binary floating point.
    expect(statutoryDays(3)).toBe(16.8);
  });

  it("a six day week is capped at 28 days", () => {
    expect(statutoryDays(6)).toBe(STATUTORY_CAP_DAYS);
    expect(statutoryDays(7)).toBe(STATUTORY_CAP_DAYS);
  });

  it("no working days earns nothing, and a negative earns nothing", () => {
    expect(statutoryDays(0)).toBe(0);
    expect(statutoryDays(-2)).toBe(0);
    expect(statutoryDays(Number.NaN)).toBe(0);
  });

  it("a half day week is honoured to one decimal", () => {
    expect(statutoryDays(2.5)).toBe(14);
    expect(statutoryDays(3.5)).toBe(19.6);
  });
});

describe("daysPerWeekFromAvailability", () => {
  it("counts only the weekdays marked true", () => {
    expect(daysPerWeekFromAvailability(FULL_WEEK)).toBe(5);
    expect(daysPerWeekFromAvailability({ monday: true, tuesday: false, saturday: true })).toBe(2);
  });

  it("a missing key means not available, and a missing map means nothing", () => {
    expect(daysPerWeekFromAvailability({})).toBe(0);
    expect(daysPerWeekFromAvailability(null)).toBe(0);
    expect(daysPerWeekFromAvailability(undefined)).toBe(0);
  });
});

describe("leaveYearBounds", () => {
  it("an April leave year runs 1 April to 31 March", () => {
    expect(leaveYearBounds(4, "2026-06-01")).toEqual({ start: "2026-04-01", end: "2027-03-31" });
  });

  it("a day BEFORE the start month belongs to the leave year that began last year", () => {
    // THE BOUNDARY. 1 March 2026 is in the leave year that started 1 April 2025;
    // an off-by-one here would move somebody's whole balance into the wrong year.
    expect(leaveYearBounds(4, "2026-03-31")).toEqual({ start: "2025-04-01", end: "2026-03-31" });
    expect(leaveYearBounds(4, "2026-04-01")).toEqual({ start: "2026-04-01", end: "2027-03-31" });
  });

  it("a January leave year is the calendar year", () => {
    expect(leaveYearBounds(1, "2024-05-01")).toEqual({ start: "2024-01-01", end: "2024-12-31" });
  });

  it("an unusable start month falls back to April rather than inventing one", () => {
    expect(leaveYearBounds(0, "2026-06-01").start.slice(5, 7)).toBe("04");
    expect(leaveYearBounds(13, "2026-06-01").start.slice(5, 7)).toBe("04");
    expect(DEFAULT_LEAVE_YEAR_START_MONTH).toBe(4);
  });

  it("A LEAP YEAR: a leave year containing 29 February is 366 days long", () => {
    const ly = leaveYearBounds(4, "2023-06-01"); // 2023-04-01 .. 2024-03-31
    expect(ly).toEqual({ start: "2023-04-01", end: "2024-03-31" });
    expect(inclusiveDays(ly.start, ly.end)).toBe(366);
    // ...and the ordinary one is 365, so the 366 above is not a constant.
    const ordinary = leaveYearBounds(4, "2026-06-01");
    expect(inclusiveDays(ordinary.start, ordinary.end)).toBe(365);
  });
});

describe("proRata", () => {
  const leapLeaveYear = { start: "2023-04-01", end: "2024-03-31" }; // 366 days

  // A JOINER is a window that opens mid-year and runs to the end of it. There was
  // a `proRataForPartYear(days, startDate, lyStart, lyEnd)` wrapper for exactly
  // this shape; it had no caller outside these three lines, so the cases now
  // exercise `proRataForWindow` directly — the function the module actually uses.
  it("a mid-year joiner gets the employed share of the year", () => {
    // 1 Oct 2023 to 31 Mar 2024 is 183 of 366 days: exactly half of 28.
    expect(proRataForWindow(28, "2023-10-01", leapLeaveYear.end, leapLeaveYear)).toBe(14);
  });

  it("joining on the first day of the leave year earns the whole entitlement", () => {
    expect(proRataForWindow(28, "2023-04-01", leapLeaveYear.end, leapLeaveYear)).toBe(28);
  });

  it("joining on the LAST day earns a tenth of a day, not nothing and not a full year", () => {
    expect(proRataForWindow(28, "2024-03-31", leapLeaveYear.end, leapLeaveYear)).toBe(0.1);
  });

  it("a window before the leave year earns nothing", () => {
    expect(proRataForWindow(28, "2022-01-01", "2022-12-31", leapLeaveYear)).toBe(0);
  });

  it("a leaver is pro-rated at the END of the window too", () => {
    // Employed 1 April to 30 September 2023: 183 of 366 days.
    expect(proRataForWindow(28, "2023-04-01", "2023-09-30", leapLeaveYear)).toBe(14);
  });
});

describe("resolveEntitlement", () => {
  it("derives days a week from the rota when the profile says nothing", () => {
    const r = resolveEntitlement({ availability: FULL_WEEK, onDay: "2026-06-01" });
    expect(r.days).toBe(28);
    expect(r.daysPerWeek).toBe(5);
    expect(r.basis).toBe("statutory");
    expect(r.daysPerWeekFromProfile).toBe(false);
  });

  it("the contracted days on the HR profile beat the rota availability", () => {
    const r = resolveEntitlement({
      availability: FULL_WEEK, // says 5
      contractedDaysPerWeek: 3, // the profile says 3
      onDay: "2026-06-01",
    });
    expect(r.daysPerWeek).toBe(3);
    expect(r.days).toBe(16.8);
    expect(r.daysPerWeekFromProfile).toBe(true);
  });

  // ZERO CONTRACTED DAYS IS THE BANK / ZERO-HOURS CASE. The profile route accepts
  // 0..7, so it is a number a manager can really store; reading it as "not set"
  // handed that person a full statutory entitlement off their rota availability
  // and showed no sign the figure they typed had been discarded.
  it("a contracted ZERO days a week is honoured, not read as 'not set'", () => {
    const r = resolveEntitlement({
      availability: FULL_WEEK, // rota says they are around 5 days
      contractedDaysPerWeek: 0, // ...but they are contracted for none
      onDay: "2026-06-01",
    });
    expect(r.daysPerWeek).toBe(0);
    expect(r.days).toBe(0);
    expect(r.daysPerWeekFromProfile).toBe(true);
    expect(r.note).toMatch(/no contracted days/i);
  });

  it("still says 'no working days recorded' when the ZERO came from an empty rota", () => {
    const r = resolveEntitlement({ availability: {}, onDay: "2026-06-01" });
    expect(r.days).toBe(0);
    expect(r.daysPerWeekFromProfile).toBe(false);
    expect(r.note).toMatch(/no working days recorded/i);
  });

  it("AN OVERRIDE WINS OVER BOTH", () => {
    const r = resolveEntitlement({
      availability: FULL_WEEK,
      contractedDaysPerWeek: 3,
      entitlementDaysOverride: 25,
      employmentStart: "2026-10-01", // would otherwise pro-rate
      onDay: "2026-11-01",
    });
    expect(r.days).toBe(25);
    expect(r.basis).toBe("override");
  });

  it("an override of zero is honoured, because zero is a decision", () => {
    const r = resolveEntitlement({ availability: FULL_WEEK, entitlementDaysOverride: 0, onDay: "2026-06-01" });
    expect(r.days).toBe(0);
    expect(r.basis).toBe("override");
  });

  it("a mid-year joiner is pro-rated against the leave year they joined in", () => {
    const r = resolveEntitlement({
      availability: FULL_WEEK,
      employmentStart: "2023-10-01",
      leaveYearStartMonth: 4,
      onDay: "2023-11-15",
    });
    expect(r.leaveYear).toEqual({ start: "2023-04-01", end: "2024-03-31" });
    expect(r.basis).toBe("pro-rata");
    expect(r.days).toBe(14);
  });

  it("somebody who left before this leave year began accrues nothing", () => {
    const r = resolveEntitlement({
      availability: FULL_WEEK,
      employmentStart: "2020-01-01",
      employmentEnd: "2025-12-31",
      onDay: "2026-06-01", // leave year 2026-04-01 .. 2027-03-31
    });
    expect(r.days).toBe(0);
    expect(r.basis).toBe("not-employed");
  });

  it("an employment start BEFORE the leave year is a full year, not a pro-rata", () => {
    const r = resolveEntitlement({
      availability: FULL_WEEK,
      employmentStart: "2019-02-11",
      onDay: "2026-06-01",
    });
    expect(r.basis).toBe("statutory");
    expect(r.days).toBe(28);
  });

  it("a six day week is capped, and says so", () => {
    const r = resolveEntitlement({
      availability: { ...FULL_WEEK, saturday: true },
      onDay: "2026-06-01",
    });
    expect(r.days).toBe(28);
    expect(r.capped).toBe(true);
  });

  it("nobody with no working days is handed a number with no basis", () => {
    const r = resolveEntitlement({ availability: {}, onDay: "2026-06-01" });
    expect(r.days).toBe(0);
    expect(r.note).toContain("No working days recorded");
  });
});
