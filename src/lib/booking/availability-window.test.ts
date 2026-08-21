// THE PATIENT-FACING HALF OF DENTALLY'S AVAILABILITY WINDOW RULE.
//
// GET /v1/appointments/availability refuses a start_time that is not strictly in
// the future and a span of 24 hours or less. MEASURED against live Dentally on
// 2026-08-21 with a read-only key:
//
//   today 00:00 -> today 23:59   400, BOTH errors
//   now+1min    -> now+23h       400, "must be greater than 24 hours"
//   now+1min    -> now+25h       200
//
// The booking reader used to send exactly the requested day range, so a SINGLE
// DAY -- what /api/booking/slots?from=X&to=X asks for the moment a patient looks
// at one day -- always spanned 24 hours or less, always 400d, and the route's
// catch turned that into "we could not load available times right now". A
// patient was told a fully open practice had nothing free.
//
// These tests pin the shape of the request rather than the outcome of one, so
// the rule is provable without touching the practice's real API.
import { describe, it, expect, vi } from "vitest";
import {
  AVAILABILITY_MIN_SPAN_MS,
  AVAILABILITY_START_BUFFER_MS,
} from "@/lib/calendar/availability";
import {
  BOOKING_SLOT_DURATION_MIN,
  bookingAvailabilityWindow,
  bookingDaysWithin,
  fetchAvailabilityDays,
  type AvailabilityReader,
  type BookingDay,
} from "./slots";

const SITE_ID = "site-cc";
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** The window Dentally itself refuses, expressed as an assertion. */
function expectDentallyWouldAccept(startTime: string, finishTime: string, nowMs: number): void {
  const startMs = Date.parse(startTime);
  const finishMs = Date.parse(finishTime);
  expect(Number.isNaN(startMs), `unparseable start_time ${startTime}`).toBe(false);
  expect(Number.isNaN(finishMs), `unparseable finish_time ${finishTime}`).toBe(false);
  expect(startMs, "start_time must be in the future").toBeGreaterThan(nowMs);
  expect(finishMs - startMs, "finish_time must be greater than 24 hours after start_time").toBeGreaterThan(
    24 * 3_600_000,
  );
}

describe("bookingAvailabilityWindow", () => {
  // 10:17 on a BST Friday: the London day runs 23:00Z Thursday to 22:59:59.999Z
  // Friday, so a single day is 24h MINUS a millisecond -- refused by a hair.
  const NOW = Date.parse("2026-08-21T09:17:31.412Z");

  it("widens a SINGLE requested day into a window Dentally will accept", () => {
    const w = bookingAvailabilityWindow("2026-08-21", "2026-08-21", NOW)!;
    expect(w).not.toBeNull();
    expectDentallyWouldAccept(w.startTime, w.finishTime, NOW);
  });

  it("widens a whole future day too, where the span is 24h minus a millisecond", () => {
    const w = bookingAvailabilityWindow("2026-09-14", "2026-09-14", NOW)!;
    expectDentallyWouldAccept(w.startTime, w.finishTime, NOW);
    // The requested day starts at London midnight, untouched by the now-clamp.
    expect(w.startTime).toBe("2026-09-13T23:00:00.000Z");
    expect(Date.parse(w.finishTime) - Date.parse(w.startTime)).toBe(AVAILABILITY_MIN_SPAN_MS);
  });

  it("asks for 25 hours, not the 24 the API names, so a DST-shifted day still clears it", () => {
    // London 25 October 2026 is the autumn changeover: 25 wall hours long.
    const w = bookingAvailabilityWindow("2026-10-25", "2026-10-25", NOW)!;
    expectDentallyWouldAccept(w.startTime, w.finishTime, NOW);
    expect(AVAILABILITY_MIN_SPAN_MS).toBeGreaterThan(24 * 3_600_000);
  });

  it("keeps a range that is ALREADY wider than the minimum exactly as asked", () => {
    const w = bookingAvailabilityWindow("2026-09-01", "2026-09-14", NOW)!;
    expect(w.startTime).toBe("2026-08-31T23:00:00.000Z");
    expect(w.finishTime).toBe("2026-09-14T22:59:59.999Z");
  });

  it("clamps a start in the past onto the ABSOLUTE booking grid, never to a raw now", () => {
    const w = bookingAvailabilityWindow("2026-08-21", "2026-08-21", NOW)!;
    // 10:17:31 London -> the next :00/:30 on the grid, not 10:19:31.
    expect(w.startTime).toBe("2026-08-21T09:30:00.000Z");
    const startMs = Date.parse(w.startTime);
    expect(startMs % (BOOKING_SLOT_DURATION_MIN * MINUTE_MS), "off-grid start").toBe(0);
  });

  it("stays strictly in the future even when now sits EXACTLY on the grid", () => {
    // ceilToSlotGrid leaves an on-grid instant alone, and Dentally would refuse
    // it: "start_time must be in the future" is not satisfied by "start_time IS
    // now". The buffer is what carries it over.
    const onGrid = Date.parse("2026-08-21T09:30:00.000Z");
    const w = bookingAvailabilityWindow("2026-08-21", "2026-08-21", onGrid)!;
    expectDentallyWouldAccept(w.startTime, w.finishTime, onGrid);
    expect(w.startTime).toBe("2026-08-21T10:00:00.000Z");
  });

  it("absorbs clock skew between our machine and Dentally's", () => {
    const w = bookingAvailabilityWindow("2026-08-21", "2026-08-21", NOW)!;
    expect(Date.parse(w.startTime) - NOW).toBeGreaterThanOrEqual(AVAILABILITY_START_BUFFER_MS);
  });

  it("returns NULL for a range that has entirely ended: there is nothing to ask", () => {
    expect(bookingAvailabilityWindow("2026-08-19", "2026-08-20", NOW)).toBeNull();
    expect(bookingAvailabilityWindow("2020-01-01", "2020-01-01", NOW)).toBeNull();
  });

  it("treats TODAY as still answerable while any of it remains", () => {
    expect(bookingAvailabilityWindow("2026-08-21", "2026-08-21", NOW)).not.toBeNull();
  });

  it("falls back to the booking horizon when `to` cannot be read, rather than refusing", () => {
    const w = bookingAvailabilityWindow("2026-08-21", "not-a-date", NOW)!;
    expect(w).not.toBeNull();
    expectDentallyWouldAccept(w.startTime, w.finishTime, NOW);
  });
});

describe("bookingDaysWithin", () => {
  const day = (date: string): BookingDay => ({ date, slots: [] });

  it("drops the extra days the widened window dragged in", () => {
    expect(bookingDaysWithin([day("2026-08-21"), day("2026-08-22")], "2026-08-21", "2026-08-21")).toEqual([
      day("2026-08-21"),
    ]);
  });

  it("keeps every day inside the requested range", () => {
    const days = [day("2026-08-21"), day("2026-08-22"), day("2026-08-23")];
    expect(bookingDaysWithin(days, "2026-08-21", "2026-08-23")).toEqual(days);
  });

  it("drops a day BEFORE the range as well as after it", () => {
    expect(bookingDaysWithin([day("2026-08-20"), day("2026-08-22")], "2026-08-21", "2026-08-21")).toEqual([]);
  });

  it("does NOT trim an unreadable range: too many days beats an empty calendar", () => {
    const days = [day("2026-08-21")];
    expect(bookingDaysWithin(days, "nonsense", "2026-08-21")).toEqual(days);
    expect(bookingDaysWithin(days, "2026-08-21", "nonsense")).toEqual(days);
    expect(bookingDaysWithin(days, "2026-08-23", "2026-08-21")).toEqual(days);
  });
});

describe("fetchAvailabilityDays against Dentally's window rule", () => {
  const NOW = new Date("2026-08-21T09:17:31.412Z");

  /** Answers with one whole-day window per requested day, and records the ask. */
  function reader(windows: Array<[string, string]>): AvailabilityReader & {
    asked: Array<{ startTime: string; finishTime: string }>;
    practitionerCalls: number;
  } {
    const asked: Array<{ startTime: string; finishTime: string }> = [];
    const self = {
      asked,
      practitionerCalls: 0,
      async listPractitioners() {
        self.practitionerCalls += 1;
        return { practitioners: [{ id: 5, active: true }] };
      },
      async getAvailability(a: { startTime: string; finishTime: string }) {
        asked.push({ startTime: a.startTime, finishTime: a.finishTime });
        const from = Date.parse(a.startTime);
        const to = Date.parse(a.finishTime);
        return {
          availability: windows
            .filter(([s, f]) => Date.parse(f) > from && Date.parse(s) < to)
            .map(([s, f]) => ({ start_time: s, finish_time: f, practitioner_id: 5 })),
        };
      },
    };
    return self;
  }

  it("SENDS a window Dentally accepts for a single requested day", async () => {
    const r = reader([["2026-08-21T13:00:00.000Z", "2026-08-21T15:00:00.000Z"]]);
    await fetchAvailabilityDays(r, SITE_ID, "2026-08-21", "2026-08-21", NOW);
    expect(r.asked).toHaveLength(1);
    expectDentallyWouldAccept(r.asked[0]!.startTime, r.asked[0]!.finishTime, NOW.getTime());
  });

  it("TRIMS the wider answer back to the single day the patient asked about", async () => {
    const r = reader([
      ["2026-08-21T13:00:00.000Z", "2026-08-21T15:00:00.000Z"], // today: wanted
      ["2026-08-22T09:00:00.000Z", "2026-08-22T11:00:00.000Z"], // tomorrow: dragged in
    ]);
    const days = await fetchAvailabilityDays(r, SITE_ID, "2026-08-21", "2026-08-21", NOW);
    expect(days.map((d) => d.date)).toEqual(["2026-08-21"]);
    expect(days[0]!.slots).toHaveLength(4); // 13:00-15:00 at 30 min
  });

  it("still returns the REAL slots for that single day: the picker is not empty", async () => {
    const r = reader([["2026-08-21T13:00:00.000Z", "2026-08-21T15:00:00.000Z"]]);
    const days = await fetchAvailabilityDays(r, SITE_ID, "2026-08-21", "2026-08-21", NOW);
    expect(days[0]!.slots.map((s) => s.start)).toEqual([
      "2026-08-21T13:00:00.000Z",
      "2026-08-21T13:30:00.000Z",
      "2026-08-21T14:00:00.000Z",
      "2026-08-21T14:30:00.000Z",
    ]);
  });

  it("issues NO REQUEST AT ALL for a range that has entirely ended, and is not an error", async () => {
    const r = reader([["2026-08-19T13:00:00.000Z", "2026-08-19T15:00:00.000Z"]]);
    const days = await fetchAvailabilityDays(r, SITE_ID, "2026-08-19", "2026-08-19", NOW);
    expect(days).toEqual([]);
    expect(r.asked).toEqual([]);
    expect(r.practitionerCalls, "a past day must not cost a practitioner read either").toBe(0);
  });

  it("keeps the 14-day default range byte-for-byte as it always was", async () => {
    const listPractitioners = vi.fn(async () => ({ practitioners: [{ id: 5, active: true }] }));
    const getAvailability = vi.fn(async (_a: unknown) => ({ availability: [] as unknown[] }));
    await fetchAvailabilityDays(
      { listPractitioners, getAvailability },
      SITE_ID,
      "2026-09-01",
      "2026-09-14",
      NOW,
    );
    const arg = getAvailability.mock.calls[0]![0] as unknown as { startTime: string; finishTime: string };
    expect(arg.startTime).toBe("2026-08-31T23:00:00.000Z");
    expect(arg.finishTime).toBe("2026-09-14T22:59:59.999Z");
  });

  it("never asks for more than the minimum span beyond the requested range", async () => {
    const r = reader([]);
    await fetchAvailabilityDays(r, SITE_ID, "2026-08-21", "2026-08-21", NOW);
    const { startTime, finishTime } = r.asked[0]!;
    const overshoot = Date.parse(finishTime) - Date.parse(startTime) - AVAILABILITY_MIN_SPAN_MS;
    expect(overshoot, "the widened window must not sprawl past the rule").toBeLessThanOrEqual(DAY_MS);
  });
});
