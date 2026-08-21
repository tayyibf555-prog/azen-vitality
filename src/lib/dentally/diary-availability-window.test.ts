// ===========================================================================
// THE WINDOW THE DIARY ACTUALLY SENDS TO DENTALLY.
//
// THE LIVE BUG THIS EXISTS TO STOP COMING BACK. Until 2026-08-21 the diary asked
// availability for londonDayStart(from) -> londonDayEnd(to), and live Dentally
// answered, on every site and every day:
//
//   400 {"error":{"type":"invalid_request_error",
//        "params":{"start_time":["must be in the future"],
//                  "finish_time":["must be greater than 24 hours"]}}}
//
// Every column in the practice hatched with "Working hours could not be read".
// The two rules were measured against live Dentally with a read-only key:
// now+1min -> now+23h is refused, now+1min -> now+25h is accepted, and a window
// is NOT clipped to start_time (a 17:50-18:00 row came back whole from a 17:55
// start), which is why widening the request loses nothing but already-ended
// windows.
//
// These tests assert the request at the seam that builds it. availability.test.ts
// pins the same two rules on the pure helper; this pins that the read USES it.
// ===========================================================================
import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";

interface AvailabilityCall {
  practitionerIds: readonly string[];
  startTime: string;
  finishTime: string;
  page?: number;
  perPage?: number;
}

const state = vi.hoisted(() => ({
  calls: [] as AvailabilityCall[],
  pages: [] as unknown[][],
  throws: false,
}));

vi.mock("./client", () => ({
  DentallyClient: class {
    constructor() {}
    getAvailability(a: AvailabilityCall) {
      state.calls.push(a);
      if (state.throws) return Promise.reject(new Error("boom"));
      return Promise.resolve({ availability: state.pages.shift() ?? [] });
    }
  },
}));

import { __setDisplayCacheForTests, listDiaryAvailabilitySafe } from "./read";
import { createDisplayCache, type DisplayCacheStore } from "./display-cache";

// THE CLOCK IS PINNED, not read. These assertions are about a window measured
// from `now`, so a real clock would make them pass or fail by the hour: a
// today-only read taken at 23:59 has no future left in it at all and correctly
// issues no call, which would look like this suite failing. 12:00 London on a
// BST day (so the London day boundary is NOT midnight UTC, which is where a
// string-sliced date would quietly pass).
const NOW = Date.parse("2026-07-31T11:00:00Z");
const TODAY = "2026-07-31";
const TOMORROW = "2026-08-01";
const YESTERDAY = "2026-07-30";

function row(startIso: string, finishIso: string, practitionerId = 1) {
  return { practitioner_id: practitionerId, start_time: startIso, finish_time: finishIso };
}

/** An ISO instant at HH:MM UTC on a London day key. Good enough for a row that
 *  only has to fall inside or outside a day, and never near a boundary. */
function at(dayKey: string, hour: number): string {
  return new Date(Date.parse(`${dayKey}T00:00:00Z`) + hour * 3_600_000).toISOString();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  state.calls = [];
  state.pages = [];
  state.throws = false;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the availability window the diary sends", () => {
  it("sends a start_time STRICTLY IN THE FUTURE for a today-only read", async () => {
    await listDiaryAvailabilitySafe({
      siteId: "site-cc",
      practitionerIds: ["1"],
      fromDayKey: TODAY,
      toDayKey: TODAY,
    });
    expect(state.calls).toHaveLength(1);
    // The old code sent London midnight of today, which is what Dentally refused
    // with "must be in the future".
    expect(Date.parse(state.calls[0]!.startTime)).toBeGreaterThan(NOW);
  });

  it("sends a finish_time MORE THAN 24 HOURS after start_time for a today-only read", async () => {
    await listDiaryAvailabilitySafe({
      siteId: "site-cc",
      practitionerIds: ["1"],
      fromDayKey: TODAY,
      toDayKey: TODAY,
    });
    const call = state.calls[0]!;
    const spanMs = Date.parse(call.finishTime) - Date.parse(call.startTime);
    // The old code sent today's 23:59:59.999, a span of well under a day, which is
    // what Dentally refused with "must be greater than 24 hours".
    expect(spanMs).toBeGreaterThan(24 * 3_600_000);
  });

  it("holds both rules on every page of the walk, not only the first", async () => {
    // A full page keeps the walk going, so page two is issued.
    state.pages = [Array.from({ length: 100 }, (_, i) => row(at(TOMORROW, 1), at(TOMORROW, 2), i)), []];
    await listDiaryAvailabilitySafe({
      siteId: "site-cc",
      practitionerIds: ["1"],
      fromDayKey: TODAY,
      toDayKey: TODAY,
    });
    expect(state.calls.length).toBeGreaterThan(1);
    for (const call of state.calls) {
      expect(Date.parse(call.startTime)).toBeGreaterThan(NOW);
      expect(Date.parse(call.finishTime) - Date.parse(call.startTime)).toBeGreaterThan(
        24 * 3_600_000,
      );
    }
  });

  it("trims the answer back to the days asked for, so tomorrow does not leak into today", async () => {
    const mine = row(at(TODAY, 14), at(TODAY, 16));
    const theirs = row(at(TOMORROW, 9), at(TOMORROW, 12));
    state.pages = [[mine, theirs]];
    const read = await listDiaryAvailabilitySafe({
      siteId: "site-cc",
      practitionerIds: ["1"],
      fromDayKey: TODAY,
      toDayKey: TODAY,
    });
    expect(read.failed).toBe(false);
    expect(read.rows).toEqual([mine]);
  });

  it("still walks a page whose rows are ALL out of range, instead of stopping short", async () => {
    // The end-of-pages signal is "this page told us nothing new", which is a fact
    // about Dentally's paging. Counting only the trimmed rows would end the walk
    // on the first all-tomorrow page and silently truncate today.
    const full = Array.from({ length: 100 }, (_, i) => row(at(TOMORROW, 1), at(TOMORROW, 2), i));
    const mine = row(at(TODAY, 14), at(TODAY, 16), 999);
    state.pages = [full, [mine]];
    const read = await listDiaryAvailabilitySafe({
      siteId: "site-cc",
      practitionerIds: ["1"],
      fromDayKey: TODAY,
      toDayKey: TODAY,
    });
    expect(state.calls).toHaveLength(2);
    expect(read.rows).toEqual([mine]);
  });
});

describe("a day Dentally can no longer answer for", () => {
  it("issues NO call at all for a range that has entirely ended", async () => {
    const read = await listDiaryAvailabilitySafe({
      siteId: "site-cc",
      practitionerIds: ["1"],
      fromDayKey: YESTERDAY,
      toDayKey: YESTERDAY,
    });
    // A guaranteed 400 against a shared hourly rate budget, whose only product
    // would be an outage message about a date in the past.
    expect(state.calls).toHaveLength(0);
    expect(read.rows).toEqual([]);
    expect(read.unanswerableDayKeys).toEqual([YESTERDAY]);
  });

  it("does NOT report a past day as a failed read", async () => {
    const read = await listDiaryAvailabilitySafe({
      siteId: "site-cc",
      practitionerIds: ["1"],
      fromDayKey: YESTERDAY,
      toDayKey: YESTERDAY,
    });
    // "Working hours could not be read ... try again shortly" is a false alarm
    // about a date nobody can do anything about. The column says the date has
    // passed instead, and that is only possible if this is not a failure.
    expect(read.failed).toBe(false);
  });

  it("names only the elapsed days of a mixed range, and still reads the rest", async () => {
    const mine = row(at(TOMORROW, 9), at(TOMORROW, 12));
    state.pages = [[mine]];
    const read = await listDiaryAvailabilitySafe({
      siteId: "site-cc",
      practitionerIds: ["1"],
      fromDayKey: YESTERDAY,
      toDayKey: TOMORROW,
    });
    expect(state.calls).toHaveLength(1);
    expect(read.failed).toBe(false);
    expect(read.unanswerableDayKeys).toEqual([YESTERDAY]);
    expect(read.rows).toEqual([mine]);
  });

  it("reports a FAILED read as failed and as unanswerable-for-nothing", async () => {
    state.throws = true;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const read = await listDiaryAvailabilitySafe({
      siteId: "site-cc",
      practitionerIds: ["1"],
      // A range CONTAINING an elapsed day, so the two answers differ: the window
      // says yesterday is unanswerable, and the failure says we know nothing
      // about any of it. An outage must not borrow the calmer "that date has
      // passed" wording -- we do not know why this failed, and the column has to
      // hatch as "we could not find out".
      fromDayKey: YESTERDAY,
      toDayKey: TOMORROW,
    });
    err.mockRestore();
    expect(read.failed).toBe(true);
    expect(read.unanswerableDayKeys).toEqual([]);
  });

  it("issues no call and reports nothing unanswerable when there are no practitioners", async () => {
    const read = await listDiaryAvailabilitySafe({
      siteId: "site-cc",
      practitionerIds: [],
      fromDayKey: TODAY,
      toDayKey: TODAY,
    });
    expect(state.calls).toHaveLength(0);
    expect(read).toEqual({
      rows: [],
      failed: false,
      unanswerableDayKeys: [],
      answerableFromMin: {},
    });
  });
});

describe("the part of today the read could not ask about", () => {
  it("reports the minute today's answer begins at, alongside the rows", async () => {
    const mine = row(at(TODAY, 14), at(TODAY, 16));
    state.pages = [[mine]];
    const read = await listDiaryAvailabilitySafe({
      siteId: "site-cc",
      practitionerIds: ["1"],
      fromDayKey: TODAY,
      toDayKey: TODAY,
    });
    // 12:00 London plus the two minute buffer, and the same wall clock as the
    // start actually sent -- the read must not report one window and send another.
    expect(read.answerableFromMin).toEqual({ [TODAY]: 12 * 60 + 2 });
    expect(read.failed).toBe(false);
  });

  it("reports NOTHING for a range entirely in the future", async () => {
    state.pages = [[]];
    const read = await listDiaryAvailabilitySafe({
      siteId: "site-cc",
      practitionerIds: ["1"],
      fromDayKey: TOMORROW,
      toDayKey: TOMORROW,
    });
    // Tomorrow is asked about from its own midnight, so an empty answer for it
    // really does mean nobody is in and the column may say so.
    expect(read.answerableFromMin).toEqual({});
  });

  it("reports NOTHING when the read failed, so an outage borrows no softer wording", async () => {
    state.throws = true;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const read = await listDiaryAvailabilitySafe({
      siteId: "site-cc",
      practitionerIds: ["1"],
      fromDayKey: TODAY,
      toDayKey: TODAY,
    });
    err.mockRestore();
    expect(read.failed).toBe(true);
    expect(read.answerableFromMin).toEqual({});
  });
});

describe("the display cache and the day that has already gone", () => {
  /** A store pre-loaded with the shape the PREVIOUS version wrote: rows and a
   *  failure flag, and no word about which days had gone by. */
  function storeHolding(value: unknown): DisplayCacheStore {
    return {
      async get() {
        return { value: JSON.parse(JSON.stringify(value)), expiresAt: Date.now() + 60_000 };
      },
      async set() {},
      async deleteByPrefix() {},
    };
  }

  afterEach(() => {
    __setDisplayCacheForTests(null);
  });

  it("recomputes which days have gone by instead of serving them from a stored row", async () => {
    // WHICH DAYS ARE PAST IS DERIVED FROM `now`, and the cache -- shared across
    // instances and outliving a deploy -- is not the authority on the time. It is
    // also why the stored shape did not change: an entry written by the version
    // that had never heard of this list must still read correctly on a live
    // diary, rather than handing the grid an undefined one.
    const cached = row(at(TOMORROW, 9), at(TOMORROW, 12));
    __setDisplayCacheForTests(createDisplayCache({ store: storeHolding({ rows: [cached], failed: false }) }));

    const read = await listDiaryAvailabilitySafe({
      siteId: "site-cc",
      practitionerIds: ["1"],
      fromDayKey: YESTERDAY,
      toDayKey: TOMORROW,
    });

    expect(state.calls).toHaveLength(0); // served from the cache, as before
    expect(read.rows).toEqual([cached]);
    expect(read.unanswerableDayKeys).toEqual([YESTERDAY]);
  });

  it("recomputes the minute today's answer begins at, rather than storing it", async () => {
    // Same rule, same reason, and this one can only ever move FORWARD as the
    // entry ages: an entry written an hour ago really does hold rows for a window
    // that has since closed, and the fresher minute declines to claim hours we
    // would rather not stand behind. The stored shape is the OLD one, with no
    // word about any of this, and it still reads correctly.
    const cached = row(at(TODAY, 14), at(TODAY, 16));
    __setDisplayCacheForTests(createDisplayCache({ store: storeHolding({ rows: [cached], failed: false }) }));

    const read = await listDiaryAvailabilitySafe({
      siteId: "site-cc",
      practitionerIds: ["1"],
      fromDayKey: TODAY,
      toDayKey: TODAY,
    });

    expect(state.calls).toHaveLength(0);
    expect(read.answerableFromMin).toEqual({ [TODAY]: 12 * 60 + 2 });
  });
});
