import { describe, expect, it } from "vitest";
import {
  UNTAGGED_FAIL_RATIO,
  dayKeysBetween,
  londonDayEndIso,
  londonDayStartIso,
  londonInstantMs,
  londonWallMinutes,
  parseAvailabilityWindows,
} from "./availability";

describe("London day boundaries", () => {
  it("is correct on a BST day (UTC+1)", () => {
    // 2026-07-31 is British Summer Time: London midnight is 23:00Z the day before.
    expect(londonDayStartIso("2026-07-31")).toBe("2026-07-30T23:00:00.000Z");
    expect(londonDayEndIso("2026-07-31")).toBe("2026-07-31T22:59:59.999Z");
  });

  it("is correct on a GMT day (UTC+0)", () => {
    expect(londonDayStartIso("2026-01-15")).toBe("2026-01-15T00:00:00.000Z");
    expect(londonDayEndIso("2026-01-15")).toBe("2026-01-15T23:59:59.999Z");
  });

  it("is correct on the spring-forward day (clocks go 01:00 -> 02:00)", () => {
    // 2026-03-29. Midnight still exists and is GMT.
    expect(londonDayStartIso("2026-03-29")).toBe("2026-03-29T00:00:00.000Z");
    // The day is 23 hours long, so it ends an hour earlier in UTC terms.
    expect(londonDayEndIso("2026-03-29")).toBe("2026-03-29T22:59:59.999Z");
  });

  it("is correct on the autumn-back day (clocks go 02:00 -> 01:00)", () => {
    // 2026-10-25. Midnight is BST, so it is 23:00Z the day before.
    expect(londonDayStartIso("2026-10-25")).toBe("2026-10-24T23:00:00.000Z");
    expect(londonDayEndIso("2026-10-25")).toBe("2026-10-25T23:59:59.999Z");
  });

  it("never string-slices: 09:00 London in July is 08:00Z, not 09:00Z", () => {
    expect(new Date(londonInstantMs("2026-07-31", 9, 0)).toISOString()).toBe("2026-07-31T08:00:00.000Z");
    expect(new Date(londonInstantMs("2026-01-15", 9, 0)).toISOString()).toBe("2026-01-15T09:00:00.000Z");
  });

  it("reads the wall clock back", () => {
    expect(londonWallMinutes(Date.parse("2026-07-31T08:00:00Z"))).toBe(9 * 60);
    expect(londonWallMinutes(Date.parse("2026-01-15T09:00:00Z"))).toBe(9 * 60);
  });
});

describe("parseAvailabilityWindows", () => {
  it("parses a plain window into day-keyed minutes", () => {
    const res = parseAvailabilityWindows([
      { start_time: "2026-07-31T13:30:00+01:00", finish_time: "2026-07-31T20:00:00+01:00", practitioner_id: "prac-4" },
    ]);
    expect(res.windows).toEqual([
      { practitionerId: "prac-4", dayKey: "2026-07-31", startMin: 810, endMin: 1200 },
    ]);
    expect(res.untagged).toBe(0);
    expect(res.total).toBe(1);
  });

  it("does NOT chunk a 390 minute window into slots", () => {
    const res = parseAvailabilityWindows([
      { start_time: "2026-07-31T13:30:00+01:00", finish_time: "2026-07-31T20:00:00+01:00", practitioner_id: "prac-4" },
    ]);
    expect(res.windows).toHaveLength(1);
    expect(res.windows[0].endMin - res.windows[0].startMin).toBe(390);
  });

  it("refuses attribution for a row with no practitioner_id and counts it", () => {
    const res = parseAvailabilityWindows([
      { start_time: "2026-07-31T09:00:00+01:00", finish_time: "2026-07-31T17:00:00+01:00" },
      { start_time: "2026-07-31T09:00:00+01:00", finish_time: "2026-07-31T17:00:00+01:00", practitioner_id: "" },
      { start_time: "2026-07-31T09:00:00+01:00", finish_time: "2026-07-31T17:00:00+01:00", practitioner_id: null },
      { start_time: "2026-07-31T09:00:00+01:00", finish_time: "2026-07-31T17:00:00+01:00", practitioner_id: "prac-1" },
    ]);
    expect(res.untagged).toBe(3);
    expect(res.total).toBe(4);
    expect(res.windows).toHaveLength(1);
    expect(res.windows[0].practitionerId).toBe("prac-1");
  });

  it("normalises a NUMERIC practitioner_id with String(), as live Dentally sends", () => {
    const res = parseAvailabilityWindows([
      { start_time: "2026-07-31T09:00:00+01:00", finish_time: "2026-07-31T10:00:00+01:00", practitioner_id: 40123 },
    ]);
    expect(res.windows[0].practitionerId).toBe("40123");
    expect(res.untagged).toBe(0);
  });

  it("parses a +01:00 row and a Z row of the SAME instant to identical minutes", () => {
    const offset = parseAvailabilityWindows([
      { start_time: "2026-07-31T14:30:00+01:00", finish_time: "2026-07-31T15:30:00+01:00", practitioner_id: "p" },
    ]);
    const zulu = parseAvailabilityWindows([
      { start_time: "2026-07-31T13:30:00Z", finish_time: "2026-07-31T14:30:00Z", practitioner_id: "p" },
    ]);
    expect(zulu.windows).toEqual(offset.windows);
    expect(offset.windows[0].startMin).toBe(870);
  });

  it("splits a window crossing London midnight into two day-keyed windows", () => {
    const res = parseAvailabilityWindows([
      { start_time: "2026-07-31T22:00:00+01:00", finish_time: "2026-08-01T02:00:00+01:00", practitioner_id: "p" },
    ]);
    expect(res.windows).toEqual([
      { practitionerId: "p", dayKey: "2026-07-31", startMin: 1320, endMin: 1440 },
      { practitionerId: "p", dayKey: "2026-08-01", startMin: 0, endMin: 120 },
    ]);
  });

  it("puts a window finishing at exactly midnight on the day it started", () => {
    const res = parseAvailabilityWindows([
      { start_time: "2026-07-31T20:00:00+01:00", finish_time: "2026-08-01T00:00:00+01:00", practitioner_id: "p" },
    ]);
    expect(res.windows).toEqual([
      { practitionerId: "p", dayKey: "2026-07-31", startMin: 1200, endMin: 1440 },
    ]);
  });

  it("drops unparseable and zero-length rows without failing the read", () => {
    const res = parseAvailabilityWindows([
      { start_time: "not a date", finish_time: "also not", practitioner_id: "p" },
      { start_time: "2026-07-31T09:00:00+01:00", finish_time: "2026-07-31T09:00:00+01:00", practitioner_id: "p" },
      { start_time: "2026-07-31T11:00:00+01:00", finish_time: "2026-07-31T10:00:00+01:00", practitioner_id: "p" },
    ]);
    expect(res.windows).toHaveLength(0);
    expect(res.untagged).toBe(0);
    expect(res.total).toBe(3);
  });

  it("tolerates a non-array payload rather than throwing", () => {
    expect(parseAvailabilityWindows(null)).toEqual({ windows: [], untagged: 0, total: 0 });
    expect(parseAvailabilityWindows({ availability: [] })).toEqual({ windows: [], untagged: 0, total: 0 });
  });
});

describe("UNTAGGED_FAIL_RATIO", () => {
  it("is the quarter threshold the caller compares against", () => {
    expect(UNTAGGED_FAIL_RATIO).toBe(0.25);
  });
});

describe("dayKeysBetween", () => {
  it("is inclusive and ordered, and empty when reversed", () => {
    expect(dayKeysBetween("2026-07-31", "2026-08-02")).toEqual([
      "2026-07-31",
      "2026-08-01",
      "2026-08-02",
    ]);
    expect(dayKeysBetween("2026-07-31", "2026-07-31")).toEqual(["2026-07-31"]);
    expect(dayKeysBetween("2026-08-02", "2026-07-31")).toEqual([]);
  });
});
