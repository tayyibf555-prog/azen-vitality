import { describe, it, expect } from "vitest";
import { generateShifts, upcomingWeekStarts, type GenerateInput } from "./generate";
import type { OpeningHours } from "@/lib/types";
import type { Absence } from "@/lib/absence/types";
import type { RotaConfig, RotaSite, RotaStaff } from "./types";

const ALL_DAYS: OpeningHours = {
  monday: "09:00-17:30",
  tuesday: "09:00-17:30",
  wednesday: "09:00-17:30",
  thursday: "09:00-17:30",
  friday: "09:00-17:30",
  saturday: "09:00-13:00",
  sunday: null,
};

function staff(over: Partial<RotaStaff> & Pick<RotaStaff, "id" | "role">): RotaStaff {
  return {
    clientId: "vitality",
    siteId: null,
    name: `Person ${over.id}`,
    phone: "+447700900000",
    email: null,
    active: true,
    availability: {
      monday: true,
      tuesday: true,
      wednesday: true,
      thursday: true,
      friday: true,
      saturday: true,
      sunday: true,
    },
    ...over,
  } as RotaStaff;
}

const ONE_SITE: RotaSite[] = [{ id: "site-a", name: "Site A", openingHours: ALL_DAYS }];
const CONFIG_ONE_EACH: RotaConfig = {
  rolesNeeded: { dentist: 1, nurse: 1 },
  notifyLeadDays: 7,
  generateWeeksAhead: 1,
};

// The week of Mon 6 Jul 2026 .. Sun 12 Jul 2026.
const WEEK = ["2026-07-06"];

describe("generateShifts", () => {
  it("covers open days and skips closed days (Sunday closed)", () => {
    const input: GenerateInput = {
      staff: [staff({ id: "d1", role: "dentist" }), staff({ id: "n1", role: "nurse" })],
      sites: ONE_SITE,
      config: CONFIG_ONE_EACH,
      weekStartDates: WEEK,
    };
    const shifts = generateShifts(input);
    const dates = [...new Set(shifts.map((s) => s.shiftDate))].sort();
    // Mon..Sat covered (6 open days), Sunday (12th) skipped.
    expect(dates).toEqual([
      "2026-07-06",
      "2026-07-07",
      "2026-07-08",
      "2026-07-09",
      "2026-07-10",
      "2026-07-11",
    ]);
    expect(shifts.some((s) => s.shiftDate === "2026-07-12")).toBe(false);
  });

  it("uses each day's opening window for start/end (Saturday is shorter)", () => {
    const shifts = generateShifts({
      staff: [staff({ id: "d1", role: "dentist" }), staff({ id: "n1", role: "nurse" })],
      sites: ONE_SITE,
      config: CONFIG_ONE_EACH,
      weekStartDates: WEEK,
    });
    const mon = shifts.find((s) => s.shiftDate === "2026-07-06")!;
    expect([mon.startTime, mon.endTime]).toEqual(["09:00", "17:30"]);
    const sat = shifts.find((s) => s.shiftDate === "2026-07-11")!;
    expect([sat.startTime, sat.endTime]).toEqual(["09:00", "13:00"]);
  });

  it("respects availability: an unavailable person is never scheduled", () => {
    const d1 = staff({
      id: "d1",
      role: "dentist",
      availability: { monday: false, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: true, sunday: false },
    });
    const shifts = generateShifts({
      staff: [d1],
      sites: ONE_SITE,
      config: { rolesNeeded: { dentist: 1 }, notifyLeadDays: 7, generateWeeksAhead: 1 },
      weekStartDates: WEEK,
    });
    // Monday (6th) has no dentist because d1 is unavailable, but Tue+ do.
    expect(shifts.some((s) => s.shiftDate === "2026-07-06")).toBe(false);
    expect(shifts.some((s) => s.shiftDate === "2026-07-07" && s.staffId === "d1")).toBe(true);
  });

  it("only considers active staff of the matching role", () => {
    const shifts = generateShifts({
      staff: [
        staff({ id: "d1", role: "dentist", active: false }), // inactive
        staff({ id: "n1", role: "nurse" }), // wrong role for a dentist slot
      ],
      sites: ONE_SITE,
      config: { rolesNeeded: { dentist: 1 }, notifyLeadDays: 7, generateWeeksAhead: 1 },
      weekStartDates: WEEK,
    });
    // No eligible dentist -> no shifts at all, but no crash.
    expect(shifts).toEqual([]);
  });

  it("leaves coverage slots unfilled when there are not enough staff (no crash)", () => {
    const shifts = generateShifts({
      staff: [staff({ id: "d1", role: "dentist" })],
      sites: ONE_SITE,
      config: { rolesNeeded: { dentist: 2 }, notifyLeadDays: 7, generateWeeksAhead: 1 },
      weekStartDates: WEEK,
    });
    // Need 2 dentists, only 1 available -> exactly one shift per open day, not two.
    const monday = shifts.filter((s) => s.shiftDate === "2026-07-06");
    expect(monday).toHaveLength(1);
  });

  it("never double-books one person across two sites on the same day", () => {
    // Same person is the only nurse; two sites both need a nurse.
    const twoSites: RotaSite[] = [
      { id: "site-a", name: "Site A", openingHours: ALL_DAYS },
      { id: "site-b", name: "Site B", openingHours: ALL_DAYS },
    ];
    const shifts = generateShifts({
      staff: [staff({ id: "n1", role: "nurse" })],
      sites: twoSites,
      config: { rolesNeeded: { nurse: 1 }, notifyLeadDays: 7, generateWeeksAhead: 1 },
      weekStartDates: WEEK,
    });
    // On Monday, n1 can only be at one site.
    const mondayForN1 = shifts.filter((s) => s.shiftDate === "2026-07-06" && s.staffId === "n1");
    expect(mondayForN1).toHaveLength(1);
  });

  it("spreads work fairly (round-robin) across an equally available pool", () => {
    // Two dentists, both fully available, one dentist needed per day. Over 6 open days
    // the load should be even (3 each), not all on the first person.
    const shifts = generateShifts({
      staff: [staff({ id: "d1", role: "dentist" }), staff({ id: "d2", role: "dentist" })],
      sites: ONE_SITE,
      config: { rolesNeeded: { dentist: 1 }, notifyLeadDays: 7, generateWeeksAhead: 1 },
      weekStartDates: WEEK,
    });
    const d1 = shifts.filter((s) => s.staffId === "d1").length;
    const d2 = shifts.filter((s) => s.staffId === "d2").length;
    expect(d1 + d2).toBe(6);
    expect(Math.abs(d1 - d2)).toBeLessThanOrEqual(1);
  });

  it("is deterministic for the same input", () => {
    const input: GenerateInput = {
      staff: [staff({ id: "d1", role: "dentist" }), staff({ id: "d2", role: "dentist" }), staff({ id: "n1", role: "nurse" })],
      sites: ONE_SITE,
      config: CONFIG_ONE_EACH,
      weekStartDates: WEEK,
    };
    expect(generateShifts(input)).toEqual(generateShifts(input));
  });

  it("generates across multiple weeks", () => {
    const shifts = generateShifts({
      staff: [staff({ id: "d1", role: "dentist" })],
      sites: ONE_SITE,
      config: { rolesNeeded: { dentist: 1 }, notifyLeadDays: 7, generateWeeksAhead: 2 },
      weekStartDates: ["2026-07-06", "2026-07-13"],
    });
    expect(shifts.some((s) => s.shiftDate === "2026-07-06")).toBe(true);
    expect(shifts.some((s) => s.shiftDate === "2026-07-13")).toBe(true);
  });

  it("assigns the same staff to a date no matter where the week sits in the window (idempotent re-gen)", () => {
    // Regression (blocker #2): the assignment for a calendar date must NOT depend
    // on how many weeks precede it in weekStartDates. A window-relative cursor gave
    // week 13 Jul a DIFFERENT staff member when it was the 2nd week of the window
    // than when it was the 1st. Since the shift unique key includes staff_id, that
    // second assignment inserts a NEW row -> duplicate shifts on every regeneration.
    const pool = [
      staff({ id: "d1", role: "dentist" }),
      staff({ id: "d2", role: "dentist" }),
      staff({ id: "d3", role: "dentist" }),
    ];
    const config: RotaConfig = { rolesNeeded: { dentist: 1 }, notifyLeadDays: 7, generateWeeksAhead: 1 };
    const target = "2026-07-13"; // the Monday of the week we compare across runs

    const asMap = (shifts: ReturnType<typeof generateShifts>) => {
      const m: Record<string, string> = {};
      for (const s of shifts) if (s.shiftDate >= target) m[s.shiftDate] = s.staffId;
      return m;
    };

    // Run A: target week is the FIRST (and only) week of the window.
    const runA = generateShifts({ staff: pool, sites: ONE_SITE, config, weekStartDates: [target] });
    // Run B: the SAME target week, but now the SECOND week (6 Jul precedes it).
    const runB = generateShifts({ staff: pool, sites: ONE_SITE, config, weekStartDates: ["2026-07-06", target] });

    expect(asMap(runB)).toEqual(asMap(runA));
    // And the target week actually produced shifts (guard against a vacuous pass).
    expect(Object.keys(asMap(runA)).length).toBeGreaterThan(0);
  });

  it("returns nothing for a role with no configured need", () => {
    const shifts = generateShifts({
      staff: [staff({ id: "h1", role: "hygienist" })],
      sites: ONE_SITE,
      config: { rolesNeeded: { dentist: 1 }, notifyLeadDays: 7, generateWeeksAhead: 1 },
      weekStartDates: WEEK,
    });
    // hygienist is not in rolesNeeded -> never scheduled.
    expect(shifts).toEqual([]);
  });
});

describe("upcomingWeekStarts", () => {
  it("returns the London Monday of the current week plus following Mondays", () => {
    // Wed 8 Jul 2026, midday UTC -> that week's Monday is 6 Jul.
    const now = new Date("2026-07-08T12:00:00Z");
    expect(upcomingWeekStarts(now, 3)).toEqual(["2026-07-06", "2026-07-13", "2026-07-20"]);
  });

  it("treats a Monday as the start of its own week", () => {
    const now = new Date("2026-07-06T09:00:00Z");
    expect(upcomingWeekStarts(now, 1)).toEqual(["2026-07-06"]);
  });

  it("treats a Sunday as the last day of the week that started six days earlier", () => {
    const now = new Date("2026-07-12T09:00:00Z"); // Sunday
    expect(upcomingWeekStarts(now, 1)).toEqual(["2026-07-06"]);
  });

  it("returns an empty list for zero or negative weeks", () => {
    const now = new Date("2026-07-08T12:00:00Z");
    expect(upcomingWeekStarts(now, 0)).toEqual([]);
    expect(upcomingWeekStarts(now, -3)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The absence seam. `generateShifts` takes absences as pure input, so "holiday
// takes you off the rota" is provable here rather than only against a live table.
// ---------------------------------------------------------------------------

function absence(over: Partial<Absence> & Pick<Absence, "id" | "staffId" | "startDate" | "endDate">): Absence {
  return {
    clientId: "vitality",
    siteId: null,
    kind: "holiday",
    status: "approved",
    note: null,
    requestedBy: null,
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    ...over,
  };
}

describe("generateShifts absence seam", () => {
  /** The dates the named person was rostered, in order. */
  function datesFor(shifts: ReturnType<typeof generateShifts>, staffId: string): string[] {
    return shifts.filter((s) => s.staffId === staffId).map((s) => s.shiftDate).sort();
  }

  const TWO_DENTISTS: RotaStaff[] = [
    staff({ id: "d1", role: "dentist" }),
    staff({ id: "d2", role: "dentist" }),
  ];
  const ONE_DENTIST_CONFIG: RotaConfig = {
    rolesNeeded: { dentist: 1 },
    notifyLeadDays: 7,
    generateWeeksAhead: 1,
  };

  const base: GenerateInput = {
    staff: TWO_DENTISTS,
    sites: ONE_SITE,
    config: ONE_DENTIST_CONFIG,
    weekStartDates: WEEK,
  };

  it("behaves exactly as before when no absences are supplied", () => {
    const without = generateShifts(base);
    const withEmpty = generateShifts({ ...base, absences: [] });
    expect(withEmpty).toEqual(without);
    expect(without.length).toBeGreaterThan(0);
  });

  it("does not roster someone on a day their APPROVED absence covers", () => {
    // Wed 8 to Fri 10 July off.
    const shifts = generateShifts({
      ...base,
      absences: [absence({ id: "a1", staffId: "d1", startDate: "2026-07-08", endDate: "2026-07-10" })],
    });
    expect(datesFor(shifts, "d1")).not.toContain("2026-07-08");
    expect(datesFor(shifts, "d1")).not.toContain("2026-07-09");
    expect(datesFor(shifts, "d1")).not.toContain("2026-07-10");
  });

  it("covers the freed slot with the other dentist rather than leaving the day empty", () => {
    const shifts = generateShifts({
      ...base,
      absences: [absence({ id: "a1", staffId: "d1", startDate: "2026-07-06", endDate: "2026-07-11" })],
    });
    // Every open day (Mon..Sat) is still covered, all of it by d2.
    expect(datesFor(shifts, "d2")).toEqual([
      "2026-07-06",
      "2026-07-07",
      "2026-07-08",
      "2026-07-09",
      "2026-07-10",
      "2026-07-11",
    ]);
    expect(datesFor(shifts, "d1")).toEqual([]);
  });

  it("leaves the slot unfilled when everyone eligible is away, rather than rostering an absent person", () => {
    const away = ["d1", "d2"].map((id) =>
      absence({ id: `a-${id}`, staffId: id, startDate: "2026-07-08", endDate: "2026-07-08" }),
    );
    const shifts = generateShifts({ ...base, absences: away });
    expect(shifts.filter((s) => s.shiftDate === "2026-07-08")).toEqual([]);
    // The surrounding days are untouched.
    expect(shifts.some((s) => s.shiftDate === "2026-07-07")).toBe(true);
    expect(shifts.some((s) => s.shiftDate === "2026-07-09")).toBe(true);
  });

  it("a PENDING request does not take anyone off the rota", () => {
    const withPending = generateShifts({
      ...base,
      absences: [
        absence({
          id: "p1",
          staffId: "d1",
          startDate: "2026-07-06",
          endDate: "2026-07-11",
          status: "pending",
        }),
      ],
    });
    expect(withPending).toEqual(generateShifts(base));
  });

  it("a refused or cancelled absence does not take anyone off the rota", () => {
    for (const status of ["refused", "cancelled"] as const) {
      const shifts = generateShifts({
        ...base,
        absences: [
          absence({ id: "x", staffId: "d1", startDate: "2026-07-06", endDate: "2026-07-11", status }),
        ],
      });
      expect(shifts).toEqual(generateShifts(base));
    }
  });

  it("only the absent person is affected", () => {
    const shifts = generateShifts({
      ...base,
      absences: [absence({ id: "a1", staffId: "d1", startDate: "2026-07-06", endDate: "2026-07-11" })],
    });
    // d2 keeps working; an absence for d1 must not remove d2 from anything.
    expect(datesFor(shifts, "d2").length).toBe(6);
  });

  it("is inclusive of both bounds: the first and last day of the absence are both skipped", () => {
    const shifts = generateShifts({
      ...base,
      staff: [staff({ id: "d1", role: "dentist" })],
      absences: [absence({ id: "a1", staffId: "d1", startDate: "2026-07-07", endDate: "2026-07-09" })],
    });
    expect(datesFor(shifts, "d1")).toEqual(["2026-07-06", "2026-07-10", "2026-07-11"]);
  });
});
