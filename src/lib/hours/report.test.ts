import { describe, it, expect } from "vitest";
import { buildMonthReport, currentMonth, monthBounds } from "./report";
import type { ClockEvent, RosteredShift } from "@/lib/clock/types";
import type { HoursStaff, PayRate } from "./types";

const STAFF: HoursStaff[] = [{ id: "s1", name: "Amina Rahman", role: "nurse", siteId: "site-cc" }];

function tap(kind: "in" | "out", iso: string, staffId = "s1"): ClockEvent {
  return {
    id: `${staffId}-${kind}-${iso}`,
    clientId: "vitality",
    siteId: "site-cc",
    staffId,
    kind,
    occurredAt: iso,
    source: "manual",
  };
}

/** A rostered 09:00 to 17:00 London shift, so a worked day raises no exception. */
function shift(shiftDate: string, staffId = "s1"): RosteredShift {
  return { staffId, siteId: "site-cc", shiftDate, startTime: "09:00", endTime: "17:00", status: "scheduled" };
}

/** Two clean eight hour days: the 10th and the 20th of June 2026 (BST, so 08:00Z is 09:00). */
const CLEAN_EVENTS: ClockEvent[] = [
  tap("in", "2026-06-10T08:00:00Z"),
  tap("out", "2026-06-10T16:00:00Z"),
  tap("in", "2026-06-20T08:00:00Z"),
  tap("out", "2026-06-20T16:00:00Z"),
];
const CLEAN_SHIFTS = [shift("2026-06-10"), shift("2026-06-20")];

/** After the month has ended, so "the month has not finished yet" is not in play. */
const AFTER_THE_MONTH = new Date("2026-07-02T10:00:00Z");

const base = {
  staff: STAFF,
  events: CLEAN_EVENTS,
  shifts: CLEAN_SHIFTS,
  month: "2026-06",
  now: AFTER_THE_MONTH,
};

describe("monthBounds", () => {
  it("covers the whole month, inclusive", () => {
    expect(monthBounds("2026-06")).toEqual({ from: "2026-06-01", to: "2026-06-30" });
    expect(monthBounds("2026-01")).toEqual({ from: "2026-01-01", to: "2026-01-31" });
  });

  it("gets February right in a leap year and an ordinary one", () => {
    expect(monthBounds("2024-02")!.to).toBe("2024-02-29");
    expect(monthBounds("2026-02")!.to).toBe("2026-02-28");
  });

  it("refuses a month it cannot read rather than guessing one", () => {
    expect(monthBounds("2026-13")).toBeNull();
    expect(monthBounds("June")).toBeNull();
    expect(monthBounds("2026-6")).toBeNull();
  });

  it("currentMonth reads the London month of an instant", () => {
    expect(currentMonth(new Date("2026-06-30T23:30:00Z"))).toBe("2026-07"); // 00:30 BST, next day
  });
});

describe("buildMonthReport: hours", () => {
  it("totals the closed sessions of the month", () => {
    const report = buildMonthReport(base);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].closedMinutes).toBe(960);
    expect(report.rows[0].sessions).toBe(2);
    expect(report.rows[0].daysWorked).toBe(2);
    expect(report.totals.closedMinutes).toBe(960);
  });

  it("A NEVER-CLOCKED-OUT SESSION CONTRIBUTES 0 MINUTES AND APPEARS IN unresolved", () => {
    // The single most important rule in the module: a missed clock-out has no
    // length, so it adds nothing, and it is raised rather than absorbed.
    const events = [
      tap("in", "2026-06-11T08:00:00Z"),
      tap("in", "2026-06-12T08:00:00Z"), // the 11th was never closed
      tap("out", "2026-06-12T16:00:00Z"),
    ];
    const report = buildMonthReport({
      ...base,
      events,
      shifts: [shift("2026-06-11"), shift("2026-06-12")],
    });
    expect(report.rows[0].closedMinutes).toBe(480); // the 12th only
    expect(report.rows[0].sessions).toBe(2);
    expect(report.rows[0].openOrUnresolvedCount).toBe(1);
    expect(report.unresolved.map((n) => n.kind)).toContain("never-clocked-out");
    expect(report.finalisable).toBe(false);
  });

  it("only counts sessions that STARTED in the month, so the margin cannot double count", () => {
    const events = [
      tap("in", "2026-05-31T08:00:00Z"), // May
      tap("out", "2026-05-31T16:00:00Z"),
      ...CLEAN_EVENTS,
      tap("in", "2026-07-01T08:00:00Z"), // July
      tap("out", "2026-07-01T16:00:00Z"),
    ];
    const report = buildMonthReport({ ...base, events });
    expect(report.rows[0].closedMinutes).toBe(960);
  });

  it("a session running past midnight is still paired, and belongs to the day it started", () => {
    // A late list finishing at half past midnight is ONE session on the 30th.
    const events = [tap("in", "2026-06-30T15:00:00Z"), tap("out", "2026-06-30T23:30:00Z")];
    const report = buildMonthReport({ ...base, events, shifts: [shift("2026-06-30")] });
    expect(report.rows[0].closedMinutes).toBe(510);
    expect(report.rows[0].daysWorked).toBe(1);
  });

  it("staff who worked nothing are still rows, with zero and not a missing person", () => {
    const report = buildMonthReport({
      ...base,
      staff: [...STAFF, { id: "s2", name: "Noah Clarke", role: "dentist", siteId: "site-cc" }],
    });
    expect(report.rows).toHaveLength(2);
    expect(report.rows[1].closedMinutes).toBe(0);
    expect(report.rows[1].sessions).toBe(0);
  });

  it("IS STABLE WHEN now MOVES WITHIN THE SAME MONTH", () => {
    const early = buildMonthReport({ ...base, now: new Date("2026-06-21T09:00:00Z") });
    const later = buildMonthReport({ ...base, now: new Date("2026-06-28T18:00:00Z") });
    expect(later.rows).toEqual(early.rows);
    expect(later.totals).toEqual(early.totals);
    expect(later.unresolved).toEqual(early.unresolved);
  });
});

describe("buildMonthReport: cost", () => {
  const rates: PayRate[] = [
    { staffId: "s1", hourlyPence: 1200, effectiveFrom: "2026-06-01", effectiveTo: null },
    { staffId: "s1", hourlyPence: 1300, effectiveFrom: "2026-06-15", effectiveTo: null },
  ];

  it("A RATE CHANGE ON THE 15th PRICES DAYS 1 TO 14 AT THE OLD RATE", () => {
    const report = buildMonthReport({ ...base, rates, includeCost: true });
    // 8h on the 10th at £12 = 9600p; 8h on the 20th at £13 = 10400p.
    expect(report.rows[0].costPence).toBe(20_000);
    expect(report.rows[0].ratesApplied).toBe(2);
    expect(report.totals.costPence).toBe(20_000);
  });

  it("A MONTH WITH NO RATE RETURNS costPence: null, NEVER 0", () => {
    const report = buildMonthReport({ ...base, rates: [], includeCost: true });
    expect(report.rows[0].costPence).toBeNull();
    expect(report.rows[0].costPence).not.toBe(0);
    expect(report.rows[0].unpricedDays).toBe(2);
    expect(report.totals.costPence).toBeNull();
  });

  it("one unpriced person nulls the TOTAL rather than understating the month", () => {
    const report = buildMonthReport({
      ...base,
      staff: [...STAFF, { id: "s2", name: "Noah Clarke", role: "dentist", siteId: "site-cc" }],
      events: [
        ...CLEAN_EVENTS,
        tap("in", "2026-06-10T08:00:00Z", "s2"),
        tap("out", "2026-06-10T16:00:00Z", "s2"),
      ],
      shifts: [...CLEAN_SHIFTS, shift("2026-06-10", "s2")],
      rates, // s1 only
      includeCost: true,
    });
    expect(report.rows[0].costPence).toBe(20_000);
    expect(report.rows[1].costPence).toBeNull();
    expect(report.totals.costPence).toBeNull();
  });

  it("WITHOUT PAY ACCESS THE COST KEYS ARE ABSENT, not null and not hidden", () => {
    // The permission is enforced by the fields never being built. A row carrying
    // `costPence: null` would still tell a reader a rate exists to be seen.
    const report = buildMonthReport({ ...base, rates, includeCost: false });
    const row = report.rows[0];
    expect("costPence" in row).toBe(false);
    expect("ratePence" in row).toBe(false);
    expect("unpricedDays" in row).toBe(false);
    expect("costPence" in report.totals).toBe(false);
    expect(report.includesCost).toBe(false);
    // And the rates handed in are not echoed anywhere in the payload.
    expect(JSON.stringify(report)).not.toContain("1300");
  });
});

describe("buildMonthReport: when the month may be called final", () => {
  it("a clean, finished month with nothing outstanding is finalisable", () => {
    const report = buildMonthReport(base);
    expect(report.unresolved).toEqual([]);
    expect(report.blockers).toEqual([]);
    expect(report.finalisable).toBe(true);
  });

  it("a month that has not finished is never finalisable", () => {
    const report = buildMonthReport({ ...base, now: new Date("2026-06-21T09:00:00Z") });
    expect(report.finalisable).toBe(false);
    expect(report.blockers.join(" ")).toContain("not finished");
  });

  it("A TRUNCATED READ BLOCKS FINALISATION AND SAYS SO", () => {
    // The 500-cap defect: if the read may be short, the figures may be short.
    const report = buildMonthReport({ ...base, truncated: true });
    expect(report.truncated).toBe(true);
    expect(report.finalisable).toBe(false);
    expect(report.blockers.join(" ")).toContain("may be short");
  });

  it("an unavailable clocking table is an honest failure, not an empty month", () => {
    const report = buildMonthReport({ ...base, ready: false });
    expect(report.ready).toBe(false);
    expect(report.rows).toEqual([]);
    expect(report.finalisable).toBe(false);
    expect(report.blockers[0]).toContain("not switched on");
  });

  it("an unreadable month reports that, rather than returning a confident empty month", () => {
    const report = buildMonthReport({ ...base, month: "2026-13" });
    expect(report.rows).toEqual([]);
    expect(report.finalisable).toBe(false);
    expect(report.blockers[0]).toContain("could not be read");
  });

  it("exceptions about people the caller cannot see are not shown to them", () => {
    // Site scoping happens in the route; the report must not re-import somebody
    // else's exception through the shared event stream.
    const report = buildMonthReport({
      ...base,
      events: [...CLEAN_EVENTS, tap("in", "2026-06-05T08:00:00Z", "other")],
    });
    expect(report.unresolved.every((n) => n.staffId === "s1")).toBe(true);
  });
});
