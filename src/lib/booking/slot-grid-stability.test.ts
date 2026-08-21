// THE SLOT GRID MUST NOT MOVE WHILE THE PATIENT IS LOOKING AT IT.
//
// Availability for TODAY has to be requested from "now" (Dentally will not answer
// for a start_time in the past), and the upstream CLIPS the window it returns to
// that requested start. Chunking from the clipped start meant the grid was
// anchored to the instant of the read, so:
//
//   - the calendar offered same-day times like 13:02 and 13:32, and
//   - the slot a patient tapped no longer existed seconds later: the create route
//     re-read availability, findExactSlot missed because the whole grid had
//     shifted, and it answered 409 "that time has just been taken" for a slot
//     nobody had taken. Every same-day slot in the first open window was
//     permanently unbookable, and the two end-to-end booking tests in
//     src/app/api/booking/in-funnel-booking-e2e.test.ts failed intermittently
//     because of it, which is how it was found.
//
// The fix anchors the query to an ABSOLUTE grid (ceilToSlotGrid), so two callers
// asking at different instants inside the same slot get the same answer, which is
// what revalidation needs in order to be able to agree with the offer.
import { describe, it, expect } from "vitest";
import {
  ceilToSlotGrid,
  fetchAvailabilityDays,
  findExactSlot,
  earliestSlots,
  BOOKING_SLOT_DURATION_MIN,
  type AvailabilityReader,
} from "./slots";

const SITE_ID = "site-cc";

/**
 * An availability source that behaves the way the local mock and (on its own
 * contract) live Dentally do: it holds a fixed free WINDOW and clips what it
 * returns to the requested start_time. The clipping is the whole point — a reader
 * that ignored start_time could not reproduce the bug.
 */
function clippingReader(windowStart: string, windowFinish: string): AvailabilityReader & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async listPractitioners() {
      return { practitioners: [{ id: "prac-1", active: true }] };
    },
    async getAvailability(a) {
      asked.push(a.startTime);
      const from = Math.max(Date.parse(windowStart), Date.parse(a.startTime));
      const to = Math.min(Date.parse(windowFinish), Date.parse(a.finishTime));
      if (!(to > from)) return { availability: [] };
      return {
        availability: [
          {
            // Whole seconds, exactly as the mock emits them.
            start_time: new Date(Math.floor(from / 1000) * 1000).toISOString(),
            finish_time: new Date(Math.floor(to / 1000) * 1000).toISOString(),
            practitioner_id: "prac-1",
          },
        ],
      };
    },
  };
}

describe("ceilToSlotGrid", () => {
  it("rounds an instant up onto the absolute booking grid", () => {
    const at = (iso: string) => new Date(ceilToSlotGrid(Date.parse(iso))).toISOString();
    expect(at("2026-08-21T12:02:14.371Z")).toBe("2026-08-21T12:30:00.000Z");
    expect(at("2026-08-21T12:29:59.999Z")).toBe("2026-08-21T12:30:00.000Z");
    expect(at("2026-08-21T12:30:00.001Z")).toBe("2026-08-21T13:00:00.000Z");
  });

  it("leaves an instant that is already on the grid alone", () => {
    const on = Date.parse("2026-08-21T12:30:00.000Z");
    expect(ceilToSlotGrid(on)).toBe(on);
  });

  it("honours a caller's own step", () => {
    expect(new Date(ceilToSlotGrid(Date.parse("2026-08-21T12:02:14Z"), 15)).toISOString()).toBe(
      "2026-08-21T12:15:00.000Z",
    );
  });
});

describe("today's availability is the same however many seconds apart it is read", () => {
  // A clinician free all afternoon; the patient is looking at it mid-window.
  const WINDOW_START = "2026-08-21T09:00:00.000Z";
  const WINDOW_FINISH = "2026-08-21T17:00:00.000Z";
  const DAY = "2026-08-21";

  function read(nowIso: string) {
    const reader = clippingReader(WINDOW_START, WINDOW_FINISH);
    return fetchAvailabilityDays(reader, SITE_ID, DAY, DAY, new Date(nowIso));
  }

  it("offers the same slots to two callers inside the same grid step", async () => {
    const a = await read("2026-08-21T12:02:14.371Z");
    const b = await read("2026-08-21T12:19:58.002Z");
    expect(a).toEqual(b);
    expect(earliestSlots(a, 1)[0].start).toBe("2026-08-21T12:30:00.000Z");
  });

  it("offers only round wall-clock times, never a ragged one", async () => {
    const days = await read("2026-08-21T12:02:14.371Z");
    for (const slot of days.flatMap((d) => d.slots)) {
      const start = new Date(slot.start);
      expect(start.getUTCSeconds(), `ragged slot ${slot.start}`).toBe(0);
      expect(start.getUTCMinutes() % BOOKING_SLOT_DURATION_MIN, `off-grid slot ${slot.start}`).toBe(0);
    }
  });

  it("REVALIDATES the slot it offered: the offer and the write agree", async () => {
    // The patient is shown the calendar...
    const offered = earliestSlots(await read("2026-08-21T12:02:14.371Z"), 3);
    const chosen = offered[1]!;
    // ...spends four minutes filling in the form, and presses Book.
    const live = await read("2026-08-21T12:06:41.905Z");
    expect(
      findExactSlot(live, chosen.start, chosen.finish, chosen.practitionerId),
      "the slot the patient chose must still be findable, or booking answers 'just been taken'",
    ).not.toBeNull();
  });

  it("still refuses a slot that has genuinely gone into the past", async () => {
    const offered = earliestSlots(await read("2026-08-21T12:02:14.371Z"), 1)[0]!;
    expect(offered.start).toBe("2026-08-21T12:30:00.000Z");
    // Half an hour later that slot has begun, so it is correctly no longer offered.
    const later = await read("2026-08-21T12:31:00.000Z");
    expect(findExactSlot(later, offered.start, offered.finish, offered.practitionerId)).toBeNull();
  });

  it("asks the upstream for a grid instant, not for a raw 'now'", async () => {
    const reader = clippingReader(WINDOW_START, WINDOW_FINISH);
    await fetchAvailabilityDays(reader, SITE_ID, DAY, DAY, new Date("2026-08-21T12:02:14.371Z"));
    expect(reader.asked[0]).toBe("2026-08-21T12:30:00.000Z");
  });

  it("leaves a FUTURE day's window untouched, since it is not clamped to now", async () => {
    const reader = clippingReader("2026-08-25T08:00:00.000Z", "2026-08-25T12:00:00.000Z");
    const days = await fetchAvailabilityDays(
      reader,
      SITE_ID,
      "2026-08-25",
      "2026-08-25",
      new Date("2026-08-21T12:02:14.371Z"),
    );
    expect(earliestSlots(days, 1)[0].start).toBe("2026-08-25T08:00:00.000Z");
    expect(days.flatMap((d) => d.slots)).toHaveLength((4 * 60) / BOOKING_SLOT_DURATION_MIN);
  });
});
