// Booking slot parsing/grouping for the PUBLIC online-booking calendar.
// Calibrated to the REAL availability row shape from live Dentally
// (scripts/dentally-find-slot.mjs: start_time / finish_time; the mock adds
// practitioner_id). Pure functions, no mocks needed.

import { describe, it, expect, vi } from "vitest";
import {
  parseAvailabilityRows,
  groupSlotsIntoLondonDays,
  fetchAvailabilityDays,
  findExactSlot,
  BOOKING_SLOT_DURATION_MIN,
} from "./slots";

const NOW = new Date("2026-06-25T12:00:00Z");

function row(start: string, finish: string, practitionerId?: string | number) {
  return { start_time: start, finish_time: finish, practitioner_id: practitionerId };
}

describe("parseAvailabilityRows", () => {
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
    expect(days[0]!.slots[0]!.start).toBe("2026-06-25T13:00:00Z");
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
    expect(days[1]!.slots.map((s) => s.start)).toEqual([
      "2026-06-27T09:00:00Z",
      "2026-06-27T15:00:00Z",
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
    expect(arg.finishTime.startsWith("2026-06-28T23:59:59")).toBe(true);
    expect(days[0]!.slots[0]!.practitionerId).toBe("5");
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
});
