import { describe, it, expect } from "vitest";
import { generateShifts, upcomingWeekStarts, type GenerateInput } from "./generate";
import { normaliseConfig, DEFAULT_ROTA_CONFIG } from "./config";
import type { OpeningHours } from "@/lib/types";
import type { RotaConfig, RotaSite, RotaStaff } from "./types";

// AREA 14 (rota): generation determinism, the generateWeeksAhead fractional->0
// guard (end to end), and the re-generation idempotency contract.
//
// The DB enforces "no duplicate shift" via a UNIQUE (client_id, staff_id,
// shift_date, start_time) key that insertShifts upserts against with
// ignoreDuplicates. That key can only work if the PURE generator is
// deterministic: same input => byte-identical rows => same key => the upsert
// dedupes. These tests pin that determinism (the property the DB relies on).

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
const CONFIG: RotaConfig = {
  rolesNeeded: { dentist: 1, nurse: 1 },
  notifyLeadDays: 7,
  generateWeeksAhead: 1,
  pairRoles: null,
};
const WEEK = ["2026-07-06"];

/** The dedupe key the DB unique index is built on. */
function shiftKey(s: { clientId: string; staffId: string; shiftDate: string; startTime: string }): string {
  return `${s.clientId}|${s.staffId}|${s.shiftDate}|${s.startTime}`;
}

describe("re-generation idempotency (the DB unique key holds only if generation is stable)", () => {
  const input: GenerateInput = {
    staff: [staff({ id: "d1", role: "dentist" }), staff({ id: "d2", role: "dentist" }), staff({ id: "n1", role: "nurse" })],
    sites: ONE_SITE,
    config: CONFIG,
    weekStartDates: WEEK,
  };

  it("produces byte-identical rows on a second run (idempotent re-generation)", () => {
    const first = generateShifts(input);
    const second = generateShifts(input);
    expect(second).toEqual(first);
  });

  it("emits no duplicate dedupe keys within a single run", () => {
    const shifts = generateShifts(input);
    const keys = shifts.map(shiftKey);
    // No two shifts share the (client, staff, date, start) key the DB would collapse.
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("re-running yields the SAME set of dedupe keys (so the upsert dedupes to zero new rows)", () => {
    const firstKeys = new Set(generateShifts(input).map(shiftKey));
    const secondKeys = new Set(generateShifts(input).map(shiftKey));
    expect([...secondKeys].sort()).toEqual([...firstKeys].sort());
    // Simulate insertShifts' ignoreDuplicates on the same key set: nothing new.
    const genuinelyNew = [...secondKeys].filter((k) => !firstKeys.has(k));
    expect(genuinelyNew).toEqual([]);
  });
});

describe("generateWeeksAhead handling (the historic fractional->0 bug)", () => {
  it("a fractional config that truncates to 0 falls back to the default, never an empty rota", () => {
    // 0.5 is the historic landmine: n > 0 is true but Math.trunc(0.5) === 0.
    const cfg = normaliseConfig({ generateWeeksAhead: 0.5 });
    expect(cfg.generateWeeksAhead).toBe(DEFAULT_ROTA_CONFIG.generateWeeksAhead);
    expect(cfg.generateWeeksAhead).toBeGreaterThan(0);
    // And that normalised value drives a non-empty week list.
    const weeks = upcomingWeekStarts(new Date("2026-07-08T12:00:00Z"), cfg.generateWeeksAhead);
    expect(weeks.length).toBe(DEFAULT_ROTA_CONFIG.generateWeeksAhead);
    expect(weeks.length).toBeGreaterThan(0);
  });

  it("upcomingWeekStarts truncates a fractional week count instead of yielding a rogue week", () => {
    const now = new Date("2026-07-08T12:00:00Z");
    // 2.9 weeks -> 2 Mondays, not 3.
    expect(upcomingWeekStarts(now, 2.9)).toEqual(["2026-07-06", "2026-07-13"]);
    // A sub-1 fractional at the generator boundary yields ZERO weeks (guarded upstream
    // by normaliseConfig, but the generator itself must not round 0.5 up to 1).
    expect(upcomingWeekStarts(now, 0.5)).toEqual([]);
  });

  it("a whole generateWeeksAhead produces exactly that many weeks of Mondays", () => {
    const now = new Date("2026-07-08T12:00:00Z");
    const weeks = upcomingWeekStarts(now, 3);
    expect(weeks).toEqual(["2026-07-06", "2026-07-13", "2026-07-20"]);
    const shifts = generateShifts({
      staff: [staff({ id: "d1", role: "dentist" })],
      sites: ONE_SITE,
      config: { rolesNeeded: { dentist: 1 }, notifyLeadDays: 7, generateWeeksAhead: 3 },
      weekStartDates: weeks,
    });
    // Each of the three week-start Mondays has a shift.
    for (const monday of weeks) {
      expect(shifts.some((s) => s.shiftDate === monday)).toBe(true);
    }
  });

  it("a role count that truncates to 0 (e.g. 0.5) is dropped, so that role generates nothing", () => {
    // Confirms the fractional->0 guard on rolesNeeded feeds generation correctly:
    // a 0.5 dentist need must not produce a "0 needed" that still schedules, nor a crash.
    const cfg = normaliseConfig({ rolesNeeded: { dentist: 0.5, nurse: 1 } });
    expect(cfg.rolesNeeded).toEqual({ nurse: 1 });
    const shifts = generateShifts({
      staff: [staff({ id: "d1", role: "dentist" }), staff({ id: "n1", role: "nurse" })],
      sites: ONE_SITE,
      config: cfg,
      weekStartDates: WEEK,
    });
    // No dentist shifts (need dropped); nurse shifts present.
    expect(shifts.some((s) => s.role === "dentist")).toBe(false);
    expect(shifts.some((s) => s.role === "nurse")).toBe(true);
  });
});
