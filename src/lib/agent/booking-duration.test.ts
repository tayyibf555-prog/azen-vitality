// The booking agent must never write a multi hour appointment into a real diary.
//
// Dentally's availability endpoint returns WINDOWS, not bookable slots, even when a
// duration is requested. Measured against live production data on 2026-07-25, 85 of
// 102 offered windows were longer than one booking and the longest ran to 390 minutes
// (Romford Road, 13:30 to 20:00). The public booking route was fixed to chunk these,
// but the agent path reached Dentally directly, so the model could still be shown a
// whole free afternoon as one slot and book the lot.
//
// Two independent guards are asserted here, because either alone is one bug away from
// a blocked clinician: find_slots must never OFFER a raw window, and book must never
// WRITE longer than the treatment needs even if it is handed one anyway.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeDispatch } from "./tools";
import type { AgentContext } from "./types";

// One 390 minute window, exactly the shape and length seen on live production.
const LONG_WINDOW = [
  { start_time: "2026-08-02T13:30:00.000+01:00", finish_time: "2026-08-02T20:00:00.000+01:00", practitioner_id: "p1" },
];

function deps(availability: unknown[], overrides: Partial<AgentContext> = {}) {
  const context: AgentContext = {
    patientId: "123",
    siteId: "site-cc",
    patientName: "Sam",
    treatment: "hygiene",
    fundingType: null,
    ...overrides,
  };
  const dentally = {
    listPractitioners: vi.fn(async () => ({ practitioners: [{ id: "p1", active: true }] })),
    getAvailability: vi.fn(async () => ({ availability })),
    createAppointment: vi.fn(async () => ({ appointment: { id: "appt-1" } })),
    createPatient: vi.fn(),
    getPatientAppointments: vi.fn(async () => ({ appointments: [] })),
    updateAppointment: vi.fn(),
    cancelAppointment: vi.fn(),
  };
  return { context, dentally };
}

const MIN = 60_000;

// THE CLOCK IS FROZEN, and this test cannot work without it.
//
// The slots below are hard-coded to 2026-08-02T13:30+01:00. `book` refuses a slot in
// the past — tools.ts anchors the availability read to Math.max(Date.now(), ...) — so
// on 2026-08-02 these tests passed all morning and began failing at 13:30, and would
// have failed on every run for the rest of the repository's life. The failure looked
// exactly like a booking regression: createAppointment simply never called.
//
// Only Date is faked. Faking every timer would hang the async paths under test.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-08-02T08:00:00.000+01:00"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("find_slots never offers a raw availability window", () => {
  it("cuts a 390 minute window into 30 minute bookable units", async () => {
    const d = deps(LONG_WINDOW);
    const out = await makeDispatch(d as never)("find_slots", { treatment: "hygiene" });
    const { slots } = JSON.parse(out) as { slots: Array<{ start_time: string; finish_time: string }> };

    expect(slots).toHaveLength(13); // 390 / 30
    for (const s of slots) {
      expect(Date.parse(s.finish_time) - Date.parse(s.start_time)).toBe(30 * MIN);
    }
    // The first unit starts when the window did, and no unit runs past its end.
    expect(Date.parse(slots[0]!.start_time)).toBe(Date.parse(LONG_WINDOW[0]!.start_time));
    expect(Date.parse(slots.at(-1)!.finish_time)).toBe(Date.parse(LONG_WINDOW[0]!.finish_time));
  });

  it("cuts to the treatment length, not a fixed half hour, so a 60 minute treatment is offered in 60 minute units", async () => {
    const d = deps(LONG_WINDOW, { treatment: "veneers" });
    const out = await makeDispatch(d as never)("find_slots", { treatment: "veneers" });
    const { slots } = JSON.parse(out) as { slots: Array<{ start_time: string; finish_time: string }> };

    expect(slots).toHaveLength(6); // 390 / 60, the 30 minute tail is dropped
    for (const s of slots) {
      expect(Date.parse(s.finish_time) - Date.parse(s.start_time)).toBe(60 * MIN);
    }
  });

  it("carries the practitioner through every unit, so each stays bookable", async () => {
    const d = deps(LONG_WINDOW);
    const out = await makeDispatch(d as never)("find_slots", { treatment: "hygiene" });
    const { slots } = JSON.parse(out) as { slots: Array<{ practitioner_id: string }> };
    expect(slots.every((s) => s.practitioner_id === "p1")).toBe(true);
  });

  it("drops a window too short for the treatment rather than offering an unbookable slot", async () => {
    const short = [
      { start_time: "2026-08-02T13:30:00.000+01:00", finish_time: "2026-08-02T14:00:00.000+01:00", practitioner_id: "p1" },
    ];
    const d = deps(short, { treatment: "veneers" });
    const out = await makeDispatch(d as never)("find_slots", { treatment: "veneers" });
    const { slots } = JSON.parse(out) as { slots: unknown[] };
    expect(slots).toHaveLength(0); // a 60 minute treatment does not fit a 30 minute gap
  });
});

describe("book clamps the appointment to the treatment length", () => {
  it("refuses to write a 390 minute appointment even when the model echoes the whole window back", async () => {
    const d = deps(LONG_WINDOW);
    await makeDispatch(d as never)("book", {
      slotStart: "2026-08-02T13:30:00.000+01:00",
      finishTime: "2026-08-02T20:00:00.000+01:00", // the raw window end, the dangerous value
      practitionerId: "p1",
      treatment: "hygiene",
    });

    expect(d.dentally.createAppointment).toHaveBeenCalledTimes(1);
    const payload = (d.dentally.createAppointment.mock.calls as unknown as Array<[Record<string, string>]>)[0]![0];
    const written = Date.parse(payload.finish_time!) - Date.parse(payload.start_time!);
    expect(written).toBe(30 * MIN); // the hygiene length, NOT the 390 minute window
  });

  it("still honours a shorter finish than the treatment length, since that only frees diary time", async () => {
    const d = deps(LONG_WINDOW);
    await makeDispatch(d as never)("book", {
      slotStart: "2026-08-02T13:30:00.000+01:00",
      finishTime: "2026-08-02T13:45:00.000+01:00",
      practitionerId: "p1",
      treatment: "hygiene",
    });
    const payload = (d.dentally.createAppointment.mock.calls as unknown as Array<[Record<string, string>]>)[0]![0];
    expect(Date.parse(payload.finish_time!) - Date.parse(payload.start_time!)).toBe(15 * MIN);
  });

  it("falls back to the treatment length when the model sends no finish at all", async () => {
    const d = deps(LONG_WINDOW);
    await makeDispatch(d as never)("book", {
      slotStart: "2026-08-02T13:30:00.000+01:00",
      practitionerId: "p1",
      treatment: "veneers",
    });
    const payload = (d.dentally.createAppointment.mock.calls as unknown as Array<[Record<string, string>]>)[0]![0];
    expect(Date.parse(payload.finish_time!) - Date.parse(payload.start_time!)).toBe(60 * MIN);
  });
});
