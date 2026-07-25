// Booking slot parsing/grouping for the PUBLIC online-booking calendar.
// Calibrated to the REAL availability row shape from live Dentally
// (scripts/dentally-find-slot.mjs: start_time / finish_time; the mock adds
// practitioner_id). Pure functions, no mocks needed.
//
// A row is a WINDOW, not a slot: live rows run to several hours even when we ask
// for duration 30, so the chunking tests below are the guard that stops a patient
// writing a multi hour appointment into a real clinician's diary.

import { describe, it, expect, vi } from "vitest";
import {
  parseAvailabilityRows,
  chunkWindowIntoSlots,
  groupSlotsIntoLondonDays,
  fetchAvailabilityDays,
  findExactSlot,
  BOOKING_SLOT_DURATION_MIN,
} from "./slots";

const NOW = new Date("2026-06-25T12:00:00Z");

function row(start: string, finish: string, practitionerId?: string | number) {
  return { start_time: start, finish_time: finish, practitioner_id: practitionerId };
}

/** Minutes between two ISO instants. */
function minutes(a: string, b: string): number {
  return (Date.parse(b) - Date.parse(a)) / 60_000;
}

describe("chunkWindowIntoSlots", () => {
  it("splits a long window into consecutive 30 minute slots (the live 390 minute case)", () => {
    // Romford Road, 2026-08-02, 13:30 to 20:00 as measured against live Dentally.
    const slots = chunkWindowIntoSlots({
      start: "2026-08-02T13:30:00.000Z",
      finish: "2026-08-02T20:00:00.000Z",
      practitionerId: "77",
    });
    expect(slots).toHaveLength(13);
    for (const s of slots) {
      expect(minutes(s.start, s.finish)).toBe(30);
      expect(s.practitionerId).toBe("77");
    }
    expect(slots[0]!.start).toBe("2026-08-02T13:30:00.000Z");
    expect(slots[0]!.finish).toBe("2026-08-02T14:00:00.000Z");
    expect(slots[12]!.start).toBe("2026-08-02T19:30:00.000Z");
    expect(slots[12]!.finish).toBe("2026-08-02T20:00:00.000Z");
    // Every slot starts exactly where the previous one finished: no gaps, no overlap.
    for (let i = 1; i < slots.length; i += 1) {
      expect(slots[i]!.start).toBe(slots[i - 1]!.finish);
    }
  });

  it("drops a remainder shorter than one slot (45 minutes yields one slot)", () => {
    const slots = chunkWindowIntoSlots({
      start: "2026-08-02T09:00:00.000Z",
      finish: "2026-08-02T09:45:00.000Z",
      practitionerId: null,
    });
    expect(slots).toEqual([
      { start: "2026-08-02T09:00:00.000Z", finish: "2026-08-02T09:30:00.000Z", practitionerId: null },
    ]);
  });

  it("yields exactly one slot for a 30 minute window and none for a shorter one", () => {
    expect(
      chunkWindowIntoSlots({
        start: "2026-08-02T09:00:00.000Z",
        finish: "2026-08-02T09:30:00.000Z",
        practitionerId: "5",
      }),
    ).toHaveLength(1);
    expect(
      chunkWindowIntoSlots({
        start: "2026-08-02T09:00:00.000Z",
        finish: "2026-08-02T09:29:00.000Z",
        practitionerId: "5",
      }),
    ).toEqual([]);
  });

  it("never throws on an unparseable window, and caps an absurd one", () => {
    expect(chunkWindowIntoSlots({ start: "nope", finish: "2026-08-02T09:30:00Z", practitionerId: null })).toEqual([]);
    // A nonsense finish (a year out) must not spin out a huge list.
    const huge = chunkWindowIntoSlots({
      start: "2026-08-02T09:00:00.000Z",
      finish: "2027-08-02T09:00:00.000Z",
      practitionerId: null,
    });
    expect(huge.length).toBeLessThanOrEqual(48);
  });
});

describe("parseAvailabilityRows", () => {
  it("chunks every window, so one long row becomes many bookable 30 minute slots", () => {
    const slots = parseAvailabilityRows([row("2026-06-26T09:00:00.000Z", "2026-06-26T11:00:00.000Z", 101)]);
    expect(slots).toHaveLength(4);
    expect(slots.map((s) => s.start)).toEqual([
      "2026-06-26T09:00:00.000Z",
      "2026-06-26T09:30:00.000Z",
      "2026-06-26T10:00:00.000Z",
      "2026-06-26T10:30:00.000Z",
    ]);
    // The window's own end is never carried through to a bookable slot.
    expect(slots.every((s) => minutes(s.start, s.finish) === BOOKING_SLOT_DURATION_MIN)).toBe(true);
  });

  it("parses the real-shape rows (numeric practitioner ids become strings)", () => {
    const slots = parseAvailabilityRows([
      row("2026-06-26T09:00:00.000Z", "2026-06-26T09:30:00.000Z", 101),
      row("2026-06-26T10:00:00.000Z", "2026-06-26T10:30:00.000Z", "prac-2"),
    ]);
    expect(slots).toEqual([
      { start: "2026-06-26T09:00:00.000Z", finish: "2026-06-26T09:30:00.000Z", practitionerId: "101" },
      { start: "2026-06-26T10:00:00.000Z", finish: "2026-06-26T10:30:00.000Z", practitionerId: "prac-2" },
    ]);
  });

  it("keeps a row with no practitioner as practitionerId null, and falls back to available_practitioner_ids", () => {
    const slots = parseAvailabilityRows([
      { start_time: "2026-06-26T09:00:00Z", finish_time: "2026-06-26T09:30:00Z" },
      {
        start_time: "2026-06-26T10:00:00Z",
        finish_time: "2026-06-26T10:30:00Z",
        available_practitioner_ids: [77, 88],
      },
    ]);
    expect(slots[0]!.practitionerId).toBeNull();
    expect(slots[1]!.practitionerId).toBe("77");
  });

  it("drops malformed rows and tolerates a non-array payload", () => {
    const slots = parseAvailabilityRows([
      null,
      "junk",
      { start_time: "not-a-date", finish_time: "2026-06-26T09:30:00Z" },
      { start_time: "2026-06-26T09:00:00Z" }, // no finish
      row("2026-06-26T09:00:00Z", "2026-06-26T09:30:00Z", 1),
    ]);
    expect(slots).toHaveLength(1);
    expect(parseAvailabilityRows(undefined)).toEqual([]);
    expect(parseAvailabilityRows({ nope: true })).toEqual([]);
  });
});

describe("groupSlotsIntoLondonDays", () => {
  it("groups by the Europe/London calendar day, not the UTC day (BST boundary)", () => {
    // 23:30Z on 30 June is 00:30 on 1 July in London (BST, UTC+1).
    const days = groupSlotsIntoLondonDays(
      parseAvailabilityRows([row("2026-06-30T23:30:00Z", "2026-07-01T00:00:00Z", 1)]),
      NOW,
    );
    expect(days).toHaveLength(1);
    expect(days[0]!.date).toBe("2026-07-01");
  });

  it("filters past slots, keeps future ones, and enforces the 60-day horizon", () => {
    const days = groupSlotsIntoLondonDays(
      parseAvailabilityRows([
        row("2026-06-25T09:00:00Z", "2026-06-25T09:30:00Z", 1), // earlier today: past
        row("2026-06-25T13:00:00Z", "2026-06-25T13:30:00Z", 1), // later today: kept
        row("2026-09-25T09:00:00Z", "2026-09-25T09:30:00Z", 1), // ~92 days out: beyond horizon
      ]),
      NOW,
    );
    expect(days).toHaveLength(1);
    expect(days[0]!.date).toBe("2026-06-25");
    expect(days[0]!.slots).toHaveLength(1);
    // Slots are now COMPUTED from the window, so the instant is what matters,
    // not the exact string Dentally happened to send.
    expect(Date.parse(days[0]!.slots[0]!.start)).toBe(Date.parse("2026-06-25T13:00:00Z"));
  });

  it("sorts days ascending and slots within a day by start time", () => {
    const days = groupSlotsIntoLondonDays(
      parseAvailabilityRows([
        row("2026-06-27T15:00:00Z", "2026-06-27T15:30:00Z", 1),
        row("2026-06-26T09:00:00Z", "2026-06-26T09:30:00Z", 1),
        row("2026-06-27T09:00:00Z", "2026-06-27T09:30:00Z", 1),
      ]),
      NOW,
    );
    expect(days.map((d) => d.date)).toEqual(["2026-06-26", "2026-06-27"]);
    expect(days[1]!.slots.map((s) => Date.parse(s.start))).toEqual([
      Date.parse("2026-06-27T09:00:00Z"),
      Date.parse("2026-06-27T15:00:00Z"),
    ]);
  });
});

describe("fetchAvailabilityDays", () => {
  const N15_UUID = "3286d822-68c5-48ff-b1a2-065780dfcd15";

  it("lists the site's ACTIVE practitioners then queries one availability window for all of them", async () => {
    const listPractitioners = vi.fn(async () => ({
      practitioners: [
        { id: 5, active: true, site_id: N15_UUID },
        { id: 7, active: true, site_id: N15_UUID },
        { id: 9, active: false, site_id: N15_UUID }, // inactive: never queried
        { id: 11, active: true, site_id: "some-other-site" }, // foreign: never queried
      ],
    }));
    const getAvailability = vi.fn(async (_a: unknown) => ({
      availability: [row("2026-06-26T09:00:00Z", "2026-06-26T09:30:00Z", 5)],
    }));
    const days = await fetchAvailabilityDays(
      { listPractitioners, getAvailability },
      "site-cc",
      "2026-06-25",
      "2026-06-28",
      NOW,
    );
    // site-cc is N15 Vitality Dental; Dentally only knows its own UUID.
    expect(listPractitioners).toHaveBeenCalledWith(N15_UUID);
    const arg = getAvailability.mock.calls[0]![0] as unknown as {
      practitionerIds: string[];
      startTime: string;
      finishTime: string;
      duration: number;
    };
    expect(arg.practitionerIds).toEqual(["5", "7"]);
    expect(arg.duration).toBe(BOOKING_SLOT_DURATION_MIN);
    // start clamps to NOW (the range began in the past relative to NOW).
    expect(Date.parse(arg.startTime)).toBeGreaterThanOrEqual(NOW.getTime());
    // June is BST, so the last instant of London 28 June is 22:59:59.999Z, NOT
    // 23:59:59.999Z. The old assertion baked in the UTC-midnight bug.
    expect(arg.finishTime).toBe("2026-06-28T22:59:59.999Z");
    expect(days[0]!.slots[0]!.practitionerId).toBe("5");
  });

  it("queries whole EUROPE/LONDON days, so BST does not shift the range by an hour", async () => {
    const listPractitioners = vi.fn(async () => ({ practitioners: [{ id: 5, active: true }] }));
    const getAvailability = vi.fn(async (_a: unknown) => ({ availability: [] as unknown[] }));
    // A range wholly in the future, so nothing clamps to `now`.
    await fetchAvailabilityDays(
      { listPractitioners, getAvailability },
      "site-cc",
      "2026-08-01",
      "2026-08-02",
      NOW,
    );
    const arg = getAvailability.mock.calls[0]![0] as unknown as {
      startTime: string;
      finishTime: string;
    };
    // BST (UTC+1): London 1 August starts at 23:00Z on 31 July and 2 August ends
    // at 22:59:59.999Z. Under the old UTC-midnight range the first London hour of
    // the day was never queried.
    expect(arg.startTime).toBe("2026-07-31T23:00:00.000Z");
    expect(arg.finishTime).toBe("2026-08-02T22:59:59.999Z");
  });

  it("uses the plain UTC boundaries in winter, when London is on GMT", async () => {
    const listPractitioners = vi.fn(async () => ({ practitioners: [{ id: 5, active: true }] }));
    const getAvailability = vi.fn(async (_a: unknown) => ({ availability: [] as unknown[] }));
    await fetchAvailabilityDays(
      { listPractitioners, getAvailability },
      "site-cc",
      "2027-01-11",
      "2027-01-12",
      NOW,
    );
    const arg = getAvailability.mock.calls[0]![0] as unknown as {
      startTime: string;
      finishTime: string;
    };
    expect(arg.startTime).toBe("2027-01-11T00:00:00.000Z");
    expect(arg.finishTime).toBe("2027-01-12T23:59:59.999Z");
  });

  it("returns no days (and never queries availability) when the site has no active practitioners", async () => {
    const listPractitioners = vi.fn(async () => ({ practitioners: [{ id: 9, active: false }] }));
    const getAvailability = vi.fn(async () => ({ availability: [] as unknown[] }));
    const days = await fetchAvailabilityDays(
      { listPractitioners, getAvailability },
      "site-cc",
      "2026-06-25",
      "2026-06-28",
      NOW,
    );
    expect(days).toEqual([]);
    expect(getAvailability).not.toHaveBeenCalled();
  });
});

describe("findExactSlot", () => {
  const days = groupSlotsIntoLondonDays(
    parseAvailabilityRows([
      row("2026-06-26T09:00:00.000Z", "2026-06-26T09:30:00.000Z", 101),
      row("2026-06-26T09:00:00.000Z", "2026-06-26T09:30:00.000Z", 102),
    ]),
    NOW,
  );

  it("matches on the exact start+finish instants (format-insensitive)", () => {
    const slot = findExactSlot(days, "2026-06-26T09:00:00Z", "2026-06-26T09:30:00Z");
    expect(slot?.practitionerId).toBe("101"); // first match when no practitioner pinned
  });

  it("honours a pinned practitioner and misses when it is not offered", () => {
    expect(findExactSlot(days, "2026-06-26T09:00:00Z", "2026-06-26T09:30:00Z", "102")?.practitionerId).toBe("102");
    expect(findExactSlot(days, "2026-06-26T09:00:00Z", "2026-06-26T09:30:00Z", "999")).toBeNull();
  });

  it("misses on a different time and on unparseable input", () => {
    expect(findExactSlot(days, "2026-06-26T10:00:00Z", "2026-06-26T10:30:00Z")).toBeNull();
    expect(findExactSlot(days, "nope", "2026-06-26T09:30:00Z")).toBeNull();
  });

  it("revalidates a chunk taken from the middle of a long window, and refuses the raw window", () => {
    // The whole point of chunking: the calendar offered 15:00 out of a 13:30 to
    // 20:00 window, so revalidation must find 15:00 to 15:30 and must NOT accept
    // a request to book the window's own 20:00 end.
    const longWindow = groupSlotsIntoLondonDays(
      parseAvailabilityRows([row("2026-06-26T13:30:00.000Z", "2026-06-26T20:00:00.000Z", 101)]),
      NOW,
    );
    expect(longWindow[0]!.slots).toHaveLength(13);
    const mid = findExactSlot(longWindow, "2026-06-26T15:00:00Z", "2026-06-26T15:30:00Z", "101");
    expect(mid).not.toBeNull();
    expect(Date.parse(mid!.finish) - Date.parse(mid!.start)).toBe(BOOKING_SLOT_DURATION_MIN * 60_000);
    expect(findExactSlot(longWindow, "2026-06-26T13:30:00Z", "2026-06-26T20:00:00Z")).toBeNull();
  });
});
