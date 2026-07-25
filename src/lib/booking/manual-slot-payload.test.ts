import { describe, it, expect } from "vitest";
import { manualBookingFieldsFromSlot, SLOT_DURATION_LABEL } from "./manual-slot-payload";
import { buildManualBookingPayload } from "@/lib/dentally/write";
import type { BookingSlot } from "@/lib/booking/slots";

const SLOT: BookingSlot = {
  start: "2026-08-03T09:00:00.000Z",
  finish: "2026-08-03T09:30:00.000Z",
  practitionerId: "914",
};

describe("manualBookingFieldsFromSlot", () => {
  it("carries the picked slot's start, end and clinician", () => {
    const built = manualBookingFieldsFromSlot(SLOT);
    expect(built).toEqual({
      fields: {
        start: SLOT.start,
        finish_time: SLOT.finish,
        practitioner_id: "914",
      },
    });
  });

  it("refuses a slot with no clinician rather than sending a write Dentally rejects", () => {
    const built = manualBookingFieldsFromSlot({ ...SLOT, practitionerId: null });
    expect("error" in built).toBe(true);
  });

  it("refuses an unusable slot", () => {
    expect("error" in manualBookingFieldsFromSlot(null)).toBe(true);
    expect("error" in manualBookingFieldsFromSlot({ ...SLOT, start: "" })).toBe(true);
    expect("error" in manualBookingFieldsFromSlot({ ...SLOT, finish: "" })).toBe(true);
    expect("error" in manualBookingFieldsFromSlot({ ...SLOT, start: "not a time" })).toBe(true);
    expect("error" in manualBookingFieldsFromSlot({ ...SLOT, finish: "not a time" })).toBe(true);
    // End before start: a mangled selection, never bookable.
    expect(
      "error" in manualBookingFieldsFromSlot({ ...SLOT, finish: "2026-08-03T08:30:00.000Z" }),
    ).toBe(true);
  });

  it("labels the fixed slot length", () => {
    expect(SLOT_DURATION_LABEL).toBe("30 min");
  });
});

describe("the drawer body satisfies buildManualBookingPayload", () => {
  // THE regression this cluster exists for: the drawers used to post
  // { targetId, start } only, and buildManualBookingPayload 400s without
  // finish_time and practitioner_id, so "Book appointment" failed on every click.
  it("is accepted, where a start-only body is refused", () => {
    const startOnly = buildManualBookingPayload({ start: SLOT.start }, "patient-1");
    expect("error" in startOnly).toBe(true);

    const built = manualBookingFieldsFromSlot(SLOT);
    if ("error" in built) throw new Error(built.error);
    const payload = buildManualBookingPayload({ ...built.fields }, "patient-1");
    expect("error" in payload).toBe(false);
  });

  it("produces a payload carrying the slot's own time and clinician", () => {
    const built = manualBookingFieldsFromSlot(SLOT);
    if ("error" in built) throw new Error(built.error);
    const payload = buildManualBookingPayload({ ...built.fields }, "patient-1");
    if ("error" in payload) throw new Error(payload.error);
    expect(payload.payload).toMatchObject({
      patient_id: "patient-1",
      start_time: SLOT.start,
      finish_time: SLOT.finish,
      practitioner_id: "914",
      booked_via_api: true,
    });
  });

  it("keeps a numeric practitioner id from real Dentally usable", () => {
    // parseAvailabilityRows normalises Dentally's numeric ids to strings; the
    // payload builder accepts either, so the round trip must still be accepted.
    const built = manualBookingFieldsFromSlot({ ...SLOT, practitionerId: "0" });
    if ("error" in built) throw new Error(built.error);
    const payload = buildManualBookingPayload({ ...built.fields }, "patient-1");
    expect("error" in payload).toBe(false);
  });
});
