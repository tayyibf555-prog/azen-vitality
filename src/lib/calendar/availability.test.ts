import { describe, expect, it } from "vitest";
import {
  AVAILABILITY_MIN_SPAN_MS,
  UNTAGGED_FAIL_RATIO,
  availabilityRowsWithinDays,
  dayKeysBetween,
  diaryAvailabilityRequest,
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

// ===========================================================================
// THE WINDOW DENTALLY WILL ACCEPT.
//
// THE BUG THIS PINS (live, every site, every day, until 2026-08-21): the diary
// asked for londonDayStart(from) -> londonDayEnd(to), and live Dentally answered
//
//   400 {"start_time":["must be in the future"],
//        "finish_time":["must be greater than 24 hours"]}
//
// so the availability read failed EVERYWHERE and every column hatched with
// "Working hours could not be read". Both halves of that rule are asserted below;
// break either and a named test here goes red.
// ===========================================================================

describe("diaryAvailabilityRequest", () => {
  const NOON = Date.parse("2026-07-31T11:00:00Z"); // 12:00 London, BST

  it("never asks about a moment in the past, even for a range starting today", () => {
    const req = diaryAvailabilityRequest({
      fromDayKey: "2026-07-31",
      toDayKey: "2026-07-31",
      nowMs: NOON,
    });
    expect(req).not.toBeNull();
    expect(Date.parse(req!.startTime)).toBeGreaterThan(NOON);
  });

  it("always asks for MORE than 24 hours, even for a single day", () => {
    // A London day is at most 25 hours and at least 23, and NONE of them is
    // "greater than 24 hours" once the start has been clamped to now.
    const req = diaryAvailabilityRequest({
      fromDayKey: "2026-07-31",
      toDayKey: "2026-07-31",
      nowMs: NOON,
    });
    const spanMs = Date.parse(req!.finishTime) - Date.parse(req!.startTime);
    expect(spanMs).toBeGreaterThan(24 * 3_600_000);
    expect(spanMs).toBe(AVAILABILITY_MIN_SPAN_MS);
  });

  it("holds both rules together for a whole future week", () => {
    const req = diaryAvailabilityRequest({
      fromDayKey: "2026-08-03",
      toDayKey: "2026-08-09",
      nowMs: NOON,
    });
    expect(Date.parse(req!.startTime)).toBeGreaterThan(NOON);
    expect(Date.parse(req!.finishTime) - Date.parse(req!.startTime)).toBeGreaterThan(24 * 3_600_000);
  });

  it("keeps the requested start when the range is entirely in the future", () => {
    const req = diaryAvailabilityRequest({
      fromDayKey: "2026-08-03",
      toDayKey: "2026-08-04",
      nowMs: NOON,
    });
    // Nothing is clamped away: a future Monday is asked about from its own
    // midnight, so the morning is not lost.
    expect(req!.startTime).toBe(londonDayStartIso("2026-08-03"));
    expect(req!.finishTime).toBe(londonDayEndIso("2026-08-04"));
    expect(req!.unanswerableDayKeys).toEqual([]);
  });

  it("returns null for a range that has entirely ended, so no doomed call is made", () => {
    expect(
      diaryAvailabilityRequest({ fromDayKey: "2026-07-29", toDayKey: "2026-07-30", nowMs: NOON }),
    ).toBeNull();
  });

  it("names the elapsed days of a mixed week instead of dropping them silently", () => {
    // Wednesday lunchtime, looking at Mon-Sun. Monday and Tuesday are over;
    // today and the rest of the week are not.
    const req = diaryAvailabilityRequest({
      fromDayKey: "2026-07-27",
      toDayKey: "2026-08-02",
      nowMs: Date.parse("2026-07-29T11:00:00Z"),
    });
    expect(req!.unanswerableDayKeys).toEqual(["2026-07-27", "2026-07-28"]);
    expect(Date.parse(req!.startTime)).toBeGreaterThan(Date.parse("2026-07-29T11:00:00Z"));
  });

  it("does not call TODAY unanswerable while any of it is left", () => {
    const req = diaryAvailabilityRequest({
      fromDayKey: "2026-07-31",
      toDayKey: "2026-07-31",
      nowMs: NOON,
    });
    expect(req!.unanswerableDayKeys).toEqual([]);
  });
});

// ===========================================================================
// THE HALF OF TODAY NOBODY CAN ASK ABOUT.
//
// The clamp above is load-bearing and correct, and it has a cost that nothing
// used to report: a window that had already CLOSED when the question was put
// never comes back. So a clinician with a 09:00-13:00 session and nothing booked
// returns an empty answer from lunchtime onwards -- and an empty answer used to
// collapse to grey, which is the sentence "not working" printed over somebody who
// was in all morning.
//
// answerableFromMin is the fact that makes that distinguishable: the minute the
// answer BEGINS. Before it, silence means nothing at all.
// ===========================================================================
describe("diaryAvailabilityRequest and the part of today that went unasked", () => {
  const NOON = Date.parse("2026-07-31T11:00:00Z"); // 12:00 London, BST

  it("names the minute TODAY's answer begins at when the clamp ate the morning", () => {
    const req = diaryAvailabilityRequest({
      fromDayKey: "2026-07-31",
      toDayKey: "2026-07-31",
      nowMs: NOON,
    });
    // 12:00 London plus the two minute skew buffer.
    expect(req!.answerableFromMin).toEqual({ "2026-07-31": 12 * 60 + 2 });
    // And it is exactly the wall clock of the start actually sent, so the two can
    // never drift apart.
    expect(req!.answerableFromMin["2026-07-31"]).toBe(
      londonWallMinutes(Date.parse(req!.startTime)),
    );
  });

  it("names NOTHING when the whole range is still to come", () => {
    // A future Monday is asked about from its own midnight, so every minute of it
    // is answered and an empty answer really does mean nobody is in.
    const req = diaryAvailabilityRequest({
      fromDayKey: "2026-08-03",
      toDayKey: "2026-08-04",
      nowMs: NOON,
    });
    expect(req!.answerableFromMin).toEqual({});
  });

  it("names ONLY the day the clamp landed in, never the days after it", () => {
    // Wednesday lunchtime, looking at Mon-Sun. Monday and Tuesday are gone
    // entirely, Wednesday is half gone, and Thursday onwards are answered whole.
    const req = diaryAvailabilityRequest({
      fromDayKey: "2026-07-27",
      toDayKey: "2026-08-02",
      nowMs: Date.parse("2026-07-29T11:00:00Z"),
    });
    expect(Object.keys(req!.answerableFromMin)).toEqual(["2026-07-29"]);
    expect(req!.answerableFromMin["2026-07-29"]).toBe(12 * 60 + 2);
  });

  it("does not name a day it has ALREADY called unanswerable", () => {
    // 23:57:59.999 London on the 31st, so the two minute buffer puts the start on
    // the 31st's very last millisecond: the day is unanswerable outright AND the
    // clamp lands inside it. Naming it here as well would give a caller two
    // answers about one day and let it honour the weaker one.
    const req = diaryAvailabilityRequest({
      fromDayKey: "2026-07-31",
      toDayKey: "2026-08-01",
      nowMs: Date.parse("2026-07-31T22:57:59.999Z"),
    });
    expect(req!.unanswerableDayKeys).toEqual(["2026-07-31"]);
    expect(req!.answerableFromMin).toEqual({});
  });

  it("names the FIRST minute of tomorrow when the buffer pushes the start over midnight", () => {
    // 23:59 London: today is over and the start lands at 00:01 tomorrow, so the
    // first minute of tomorrow genuinely went unasked and is reported as such.
    const req = diaryAvailabilityRequest({
      fromDayKey: "2026-07-31",
      toDayKey: "2026-08-01",
      nowMs: Date.parse("2026-07-31T22:59:00Z"),
    });
    expect(req!.unanswerableDayKeys).toEqual(["2026-07-31"]);
    expect(req!.answerableFromMin).toEqual({ "2026-08-01": 1 });
  });

  it("keeps the two rules Dentally enforces, whatever it reports about the minute", () => {
    const req = diaryAvailabilityRequest({
      fromDayKey: "2026-07-31",
      toDayKey: "2026-07-31",
      nowMs: NOON,
    });
    expect(Date.parse(req!.startTime)).toBeGreaterThan(NOON);
    expect(Date.parse(req!.finishTime) - Date.parse(req!.startTime)).toBeGreaterThan(
      24 * 3_600_000,
    );
  });
});

describe("availabilityRowsWithinDays", () => {
  const row = (start: string, finish: string) => ({
    practitioner_id: 1,
    start_time: start,
    finish_time: finish,
  });

  it("drops the extra days the widened window drags in", () => {
    const today = row("2026-07-31T14:00:00+01:00", "2026-07-31T17:00:00+01:00");
    const tomorrow = row("2026-08-01T09:00:00+01:00", "2026-08-01T12:00:00+01:00");
    expect(availabilityRowsWithinDays([today, tomorrow], "2026-07-31", "2026-07-31")).toEqual([today]);
  });

  it("keeps a row that merely OVERLAPS the requested range", () => {
    // Split across the day boundary by parseAvailabilityWindows, so it must
    // survive the trim: half of it belongs to the day that was asked for.
    const overnight = row("2026-07-31T22:00:00+01:00", "2026-08-01T02:00:00+01:00");
    expect(availabilityRowsWithinDays([overnight], "2026-07-31", "2026-07-31")).toEqual([overnight]);
  });

  it("treats a window finishing exactly at London midnight as the previous day's", () => {
    const untilMidnight = row("2026-07-31T20:00:00+01:00", "2026-08-01T00:00:00+01:00");
    expect(availabilityRowsWithinDays([untilMidnight], "2026-08-01", "2026-08-01")).toEqual([]);
    expect(availabilityRowsWithinDays([untilMidnight], "2026-07-31", "2026-07-31")).toEqual([
      untilMidnight,
    ]);
  });

  it("keeps a row it cannot parse, rather than hiding a shape change", () => {
    const junk = { practitioner_id: 1 };
    expect(availabilityRowsWithinDays([junk], "2026-07-31", "2026-07-31")).toEqual([junk]);
  });
});
