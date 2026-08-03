// ===========================================================================
// THE MOCK MUST NOT BE TIDIER THAN PRODUCTION.
//
// A live probe on 2026-08-02 found only 17 of 100 treatment_plan_items carrying a
// treatment_appointment_id: 83% of a real patient's plan belongs to no appointment
// card. A fixture set where every row sat neatly under a card would make the
// unassigned bucket unreachable in dev, and the panel would look complete on every
// local render while dropping most of a real plan.
//
// That is not hypothetical. The blank surfaces and the unparsed Palmer teeth both
// shipped on this feature and were caught late, and both survived local dev for
// the same reason: the mock was neater than the data. So the awkward shapes are
// pinned here, and a future contributor who "cleans up" the fixtures fails this
// file rather than the screen.
// ===========================================================================

import { describe, it, expect } from "vitest";
import {
  MOCK_APPOINTMENTS,
  MOCK_TREATMENT_APPOINTMENTS,
  MOCK_TREATMENT_PLAN_ITEMS,
  treatmentAppointmentsForPatient,
  treatmentPlanItemsForPatient,
} from "@/app/api/mock-dentally/_fixtures";

describe("the plan-panel fixtures mirror the live distribution", () => {
  it("leaves MOST items with no appointment card at all", () => {
    const all = MOCK_TREATMENT_PLAN_ITEMS;
    const assigned = all.filter((i) => i.treatment_appointment_id !== null);
    expect(all.length).toBeGreaterThan(0);
    // Live is 17%. Anything under a third keeps the unassigned bucket the dominant
    // case in dev, which is the point.
    expect(assigned.length / all.length).toBeLessThan(0.34);
    expect(assigned.length).toBeGreaterThan(0);
  });

  it("gives at least one patient a plan with NO cards whatsoever", () => {
    // The pure 83% case: a patient whose whole plan is unassigned. A panel built as
    // pure "Appt. 1 / Appt. 2" groups renders this patient an empty screen.
    const items = treatmentPlanItemsForPatient("pat-004");
    expect(items.length).toBeGreaterThan(0);
    expect(treatmentAppointmentsForPatient("pat-004")).toHaveLength(0);
    expect(items.every((i) => i.treatment_appointment_id === null)).toBe(true);
  });

  it("has a card whose linked diary appointment RESOLVES", () => {
    const card = MOCK_TREATMENT_APPOINTMENTS.find((t) => t.id === "ta-001");
    expect(card?.appointment_id).toBe("appt-001a");
    const diary = MOCK_APPOINTMENTS.find((a) => a.id === card?.appointment_id);
    expect(diary).toBeDefined();
    // The header's clinician comes off the DIARY row, not off the card. Strip these
    // and ta-001 renders a booked appointment with a blank clinician.
    expect(diary?.practitioner).toBeTruthy();
    expect(diary?.practitioner_id).toBeTruthy();
    expect(diary?.start_time).toBeTruthy();
  });

  it("has a card whose linked diary appointment CANNOT be resolved", () => {
    // Dangling references are ordinary after a cancellation or a merge. Without one
    // here, the "we could not resolve this card's header" sentence could only ever
    // be seen against live data.
    const card = MOCK_TREATMENT_APPOINTMENTS.find((t) => t.id === "ta-002");
    expect(card?.appointment_id).toBe("appt-does-not-exist");
    expect(MOCK_APPOINTMENTS.some((a) => a.id === card?.appointment_id)).toBe(false);
  });

  it("has a card that was never booked into the diary at all", () => {
    // A different fact from the dangling one, and it must read differently.
    const card = MOCK_TREATMENT_APPOINTMENTS.find((t) => t.id === "ta-003");
    expect(card?.appointment_id).toBeNull();
  });

  it("numbers cards from a ZERO-BASED position — position 0 is 'Appt. 1'", () => {
    expect(treatmentAppointmentsForPatient("pat-001").map((t) => t.position)).toEqual([0, 1, 2]);
  });

  it("puts BOTH funding codes on one card, and a zero-price row on it", () => {
    // A card mixing NHS and private is the ordinary case on a real plan, and £0.00
    // is a real value (an image inside a band), not an absence.
    const rows = MOCK_TREATMENT_PLAN_ITEMS.filter((i) => i.treatment_appointment_id === "ta-001");
    expect(new Set(rows.map((r) => r.payment_plan_id))).toEqual(new Set([1, 2]));
    expect(rows.some((r) => r.price === 0)).toBe(true);
  });

  it("gives every treatment_plan_item a UNIQUE id", () => {
    // They were not unique: pat-001 and pat-004 both carried tpi-015 and tpi-016.
    // Nothing keyed on the id until the plan panel, which keys rows by it.
    const ids = MOCK_TREATMENT_PLAN_ITEMS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
