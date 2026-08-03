// ===========================================================================
// THE TREATMENT PLAN PANEL ENGINE — tests.
//
// These are written against the ONE fact that shapes the whole panel: on live
// production data only 17 of 100 treatment_plan_items carry a
// treatment_appointment_id. 83% of a real patient's plan belongs to NO
// appointment card. A panel built as pure "Appt. 1 / Appt. 2" groups drops most
// of the plan and still LOOKS complete, which is the same failure class as the
// blank surfaces and the unparsed Palmer teeth — both of which shipped on this
// feature and were caught late.
//
// So the first block below is not a nice-to-have edge case. It is the spec.
//
// MUTATION LOG. Every mutation below was actually APPLIED to plan-panel.ts and
// the suite re-run, because a test that passes on the broken build is not a test.
// The counts are what was observed, out of 31.
//
//   M1  Drop the unassigned bucket entirely (`if (loose.length > 0)` -> `if
//       (false)`).                                            11 failed / 20 passed
//       Bites on: "surfaces the 83 unassigned items as their own counted group",
//       "loses no item" (83 of 100 rows gone), reconciliation.balanced === false.
//   M2  Fold the unassigned rows into the first appointment card instead.
//                                                              6 failed / 25 passed
//       Bites on: "never folds unassigned items into a card", and on "a card's
//       totals equal its own visible rows" once foreign rows land in the footer.
//   M3  Take a card's price total from the plan header rather than its rows.
//                                                              3 failed / 28 passed
//   M4  Return a single winning funding code per card (first row wins).
//                                                              1 failed / 30 passed
//   M5  Skip zero-price, zero-duration items as "nothing to show".
//                                                             11 failed / 20 passed
//   M6  Number cards by render index instead of by `position`. 2 failed / 29 passed
//   M7  Drop items whose treatment_appointment_id matches no appointment we read.
//                                                              2 failed / 29 passed
//   M8  Compute the plan's private total by summing the item rows.
//                                                              2 failed / 29 passed
//   M9  Hide the uncharged line when it is zero (return null). 1 failed / 30 passed
// ===========================================================================

import { describe, expect, it } from "vitest";
import {
  UNASSIGNED_GROUP_KEY,
  UNASSIGNED_LABEL,
  appointmentGroups,
  buildPlanPanel,
  describeUnassigned,
  unassignedGroup,
  type PlanAppointment,
  type PlanHeader,
  type PlanPanelItem,
} from "./plan-panel";

// --- Fixtures --------------------------------------------------------------
// A full PlanPanelItem, so the factory keeps compiling if ChartItem grows a
// field. Overrides are applied last.

function makeItem(over: Partial<PlanPanelItem> & { id: string }): PlanPanelItem {
  return {
    teeth: [],
    rawTeeth: "",
    surfaces: [],
    rawSurfaces: "",
    surfaceIndices: [],
    unrecognisedSurfaces: [],
    wholeTooth: false,
    region: null,
    baseChart: false,
    completed: false,
    completedAt: null,
    charged: false,
    notes: null,
    nomenclature: "Treatment",
    price: 0,
    value: 0,
    durationMin: 0,
    nhsTreatmentCat: null,
    udaBand: null,
    position: 0,
    planId: "688300",
    treatmentId: null,
    practitionerId: null,
    paymentPlanId: 1,
    createdAt: null,
    updatedAt: null,
    treatmentAppointmentId: null,
    pricePence: 0,
    ...over,
  };
}

function makeAppt(over: Partial<PlanAppointment> & { id: string }): PlanAppointment {
  return {
    position: 0,
    appointmentId: null,
    notes: null,
    bookable: true,
    ...over,
  };
}

function makePlan(over: Partial<PlanHeader> = {}): PlanHeader {
  return {
    id: "688300",
    nickname: "Treatment plan",
    completed: false,
    completedAt: null,
    startDate: null,
    endDate: null,
    paymentPlanId: 1,
    practitionerId: null,
    privateTreatmentValuePence: 0,
    nhsUdaHundredths: 0,
    nhsCompletedUdaHundredths: 0,
    ...over,
  };
}

/** Every row the model would put on screen, across every group. If an
 *  implementation drops a bucket, this is short. */
function renderedIds(model: ReturnType<typeof buildPlanPanel>): string[] {
  return model.groups.flatMap((g) => g.rows.map((r) => r.item.id));
}

// ---------------------------------------------------------------------------

describe("the 83% case — most of a real plan has no appointment", () => {
  // Reproduces the live shape measured on 2026-08-02: 100 items, 17 of them
  // attached to an appointment, 83 attached to nothing at all.
  const appts = [makeAppt({ id: "a1", position: 0 }), makeAppt({ id: "a2", position: 1 })];
  const items = Array.from({ length: 100 }, (_, i) =>
    makeItem({
      id: `i${i}`,
      position: i,
      pricePence: 100,
      durationMin: 5,
      treatmentAppointmentId: i < 10 ? "a1" : i < 17 ? "a2" : null,
    }),
  );
  const model = buildPlanPanel({ plan: makePlan(), appointments: appts, items });

  it("surfaces the 83 unassigned items as their own counted group", () => {
    const bucket = model.groups.find((g) => g.kind === "unassigned");
    expect(bucket).toBeDefined();
    expect(bucket?.rows).toHaveLength(83);
    expect(bucket?.totals.itemCount).toBe(83);
    expect(model.unassignedItemCount).toBe(83);
    // The group announces itself in words, not just as a number.
    expect(bucket?.label).toBe(UNASSIGNED_LABEL);
    expect(bucket?.kind === "unassigned" && bucket.reason).toContain("83");
  });

  it("loses no item — every input row is rendered exactly once", () => {
    const ids = renderedIds(model);
    expect(ids).toHaveLength(100);
    expect(new Set(ids).size).toBe(100);
    expect(model.reconciliation).toEqual({
      inputItemCount: 100,
      groupedItemCount: 100,
      balanced: true,
    });
  });

  it("never folds unassigned items into a card", () => {
    const cards = appointmentGroups(model);
    expect(cards.map((c) => c.rows.length)).toEqual([10, 7]);
    for (const card of cards) {
      for (const row of card.rows) {
        expect(row.item.treatmentAppointmentId).toBe(card.appointment.id);
      }
    }
  });

  it("orders the unassigned bucket last, so the cards read first", () => {
    expect(model.groups.map((g) => g.kind)).toEqual(["appointment", "appointment", "unassigned"]);
    expect(model.groups.at(-1)?.key).toBe(UNASSIGNED_GROUP_KEY);
  });

  it("exposes no appointments-only collection that could be rendered alone", () => {
    // The model deliberately has ONE row-bearing field. A consumer that maps
    // `groups` cannot forget the bucket, because there is nothing else to map.
    const rowBearing = Object.entries(model).filter(
      ([, v]) => Array.isArray(v) && v.some((x) => x && typeof x === "object" && "rows" in x),
    );
    expect(rowBearing.map(([k]) => k)).toEqual(["groups"]);
  });
});

describe("a card's totals equal its own visible rows", () => {
  // The reference screenshot: 0 + 15 + 30 = 45 min, £0.00.
  const items = [
    makeItem({ id: "r1", treatmentAppointmentId: "a1", position: 0, durationMin: 0, pricePence: 0 }),
    makeItem({ id: "r2", treatmentAppointmentId: "a1", position: 1, durationMin: 15, pricePence: 0 }),
    makeItem({ id: "r3", treatmentAppointmentId: "a1", position: 2, durationMin: 30, pricePence: 0 }),
    // A second card, and a loose item, both of which must stay out of card 1.
    makeItem({ id: "r4", treatmentAppointmentId: "a2", durationMin: 60, pricePence: 12_345 }),
    makeItem({ id: "r5", treatmentAppointmentId: null, durationMin: 90, pricePence: 99_999 }),
  ];
  const model = buildPlanPanel({
    plan: makePlan({ privateTreatmentValuePence: 1, nhsUdaHundredths: 1 }),
    appointments: [makeAppt({ id: "a1", position: 0 }), makeAppt({ id: "a2", position: 1 })],
    items,
  });

  it("matches the reference card: 45 minutes and £0.00", () => {
    const card = appointmentGroups(model)[0];
    expect(card.totals.durationMin).toBe(45);
    expect(card.totals.pricePence).toBe(0);
    expect(card.totals.itemCount).toBe(3);
  });

  it("holds for every group, computed from the rows the group actually shows", () => {
    for (const group of model.groups) {
      const duration = group.rows.reduce((n, r) => n + r.item.durationMin, 0);
      const price = group.rows.reduce((n, r) => n + r.item.pricePence, 0);
      expect(group.totals.durationMin).toBe(duration);
      expect(group.totals.pricePence).toBe(price);
      expect(group.totals.itemCount).toBe(group.rows.length);
    }
  });

  it("counts completed rows per card", () => {
    const model2 = buildPlanPanel({
      plan: makePlan(),
      appointments: [makeAppt({ id: "a1" })],
      items: [
        makeItem({ id: "c1", treatmentAppointmentId: "a1", completed: true }),
        makeItem({ id: "c2", treatmentAppointmentId: "a1", completed: false }),
      ],
    });
    expect(appointmentGroups(model2)[0].totals.completedCount).toBe(1);
  });
});

describe("funding", () => {
  it("a card may legitimately mix funding — the distinct set, never one winner", () => {
    const model = buildPlanPanel({
      plan: makePlan(),
      appointments: [makeAppt({ id: "a1" })],
      items: [
        makeItem({ id: "f1", treatmentAppointmentId: "a1", paymentPlanId: 2 }),
        makeItem({ id: "f2", treatmentAppointmentId: "a1", paymentPlanId: 1 }),
        makeItem({ id: "f3", treatmentAppointmentId: "a1", paymentPlanId: 1 }),
        makeItem({ id: "f4", treatmentAppointmentId: "a1", paymentPlanId: 47752 }),
      ],
    });
    const card = appointmentGroups(model)[0];
    expect(card.funding).toEqual(["nhs", "private", "udc"]);
    expect(card.rows.map((r) => r.fundingLabel)).toEqual(["Private", "NHS", "NHS", "UDC"]);
  });

  it("keeps an unrecognised payment plan as 'unknown', never as private", () => {
    const model = buildPlanPanel({
      plan: makePlan(),
      appointments: [],
      items: [
        makeItem({ id: "u1", paymentPlanId: 9999 }),
        makeItem({ id: "u2", paymentPlanId: null }),
      ],
    });
    expect(model.funding).toEqual(["unknown"]);
    expect(model.groups[0].rows.map((r) => r.funding)).toEqual(["unknown", "unknown"]);
    // The empty label is the point: an unresolved plan prints nothing at all.
    expect(model.groups[0].rows.map((r) => r.fundingLabel)).toEqual(["", ""]);
  });

  it("rolls plan-level funding up from the items, and keeps the plan's own code apart", () => {
    const model = buildPlanPanel({
      plan: makePlan({ paymentPlanId: 2 }),
      appointments: [makeAppt({ id: "a1" })],
      items: [
        makeItem({ id: "p1", treatmentAppointmentId: "a1", paymentPlanId: 1 }),
        makeItem({ id: "p2", paymentPlanId: 1 }),
      ],
    });
    expect(model.funding).toEqual(["nhs"]);
    expect(model.headerFunding).toBe("private");
  });

  it("gives an empty card no funding badges at all", () => {
    const model = buildPlanPanel({
      plan: makePlan(),
      appointments: [makeAppt({ id: "a1" })],
      items: [],
    });
    expect(appointmentGroups(model)[0].funding).toEqual([]);
  });
});

describe("zero and empty are real values, not absences", () => {
  it("keeps zero-price and zero-duration items as real rows", () => {
    const model = buildPlanPanel({
      plan: makePlan(),
      appointments: [makeAppt({ id: "a1" })],
      items: [
        makeItem({ id: "z1", treatmentAppointmentId: "a1", pricePence: 0, durationMin: 0 }),
        makeItem({ id: "z2", treatmentAppointmentId: "a1", pricePence: 0, durationMin: 0 }),
      ],
    });
    const card = appointmentGroups(model)[0];
    expect(card.rows).toHaveLength(2);
    expect(card.totals.itemCount).toBe(2);
    expect(card.totals.pricePence).toBe(0);
    expect(card.totals.durationMin).toBe(0);
    expect(model.reconciliation.balanced).toBe(true);
  });

  it("an appointment with no items still renders as a card", () => {
    const model = buildPlanPanel({
      plan: makePlan(),
      appointments: [makeAppt({ id: "a1", position: 0, notes: "Acquire images" })],
      items: [],
    });
    expect(model.groups).toHaveLength(1);
    const card = appointmentGroups(model)[0];
    expect(card.number).toBe(1);
    expect(card.appointment.notes).toBe("Acquire images");
    expect(card.rows).toEqual([]);
    expect(card.totals).toEqual({
      itemCount: 0,
      completedCount: 0,
      durationMin: 0,
      pricePence: 0,
      unreadableFigures: 0,
    });
  });

  it("a plan with no appointments at all puts every item in the bucket", () => {
    const items = [makeItem({ id: "n1" }), makeItem({ id: "n2" }), makeItem({ id: "n3" })];
    const model = buildPlanPanel({ plan: makePlan(), appointments: [], items });
    expect(model.groups).toHaveLength(1);
    expect(model.groups[0].kind).toBe("unassigned");
    expect(renderedIds(model)).toEqual(["n1", "n2", "n3"]);
    expect(model.appointmentGroupCount).toBe(0);
  });

  it("an empty plan produces no groups and still balances", () => {
    const model = buildPlanPanel({ plan: makePlan(), appointments: [], items: [] });
    expect(model.groups).toEqual([]);
    expect(model.unassignedItemCount).toBe(0);
    expect(model.reconciliation.balanced).toBe(true);
    expect(unassignedGroup(model)).toBeNull();
  });
});

describe("numbering and ordering", () => {
  it("numbers cards from the appointment's own position, not from render order", () => {
    const model = buildPlanPanel({
      plan: makePlan(),
      appointments: [
        makeAppt({ id: "c", position: 2 }),
        makeAppt({ id: "a", position: 0 }),
        makeAppt({ id: "b", position: 1 }),
      ],
      items: [],
    });
    const cards = appointmentGroups(model);
    expect(cards.map((c) => c.appointment.id)).toEqual(["a", "b", "c"]);
    expect(cards.map((c) => c.number)).toEqual([1, 2, 3]);
    expect(cards.map((c) => c.label)).toEqual(["Appt. 1", "Appt. 2", "Appt. 3"]);
  });

  it("refuses to invent a number when position is unreadable", () => {
    const model = buildPlanPanel({
      plan: makePlan(),
      appointments: [makeAppt({ id: "a1", position: 0 }), makeAppt({ id: "bad", position: NaN })],
      items: [],
    });
    const bad = appointmentGroups(model).find((c) => c.appointment.id === "bad");
    expect(bad?.number).toBeNull();
    expect(bad?.label).toBe("Appointment");
    // Unnumbered cards sort after the numbered ones rather than claiming "Appt. 1".
    expect(appointmentGroups(model).map((c) => c.appointment.id)).toEqual(["a1", "bad"]);
  });

  it("sorts rows within a card by the item's own position, stably on ties", () => {
    const model = buildPlanPanel({
      plan: makePlan(),
      appointments: [makeAppt({ id: "a1" })],
      items: [
        makeItem({ id: "third", treatmentAppointmentId: "a1", position: 5 }),
        makeItem({ id: "tie-a", treatmentAppointmentId: "a1", position: 1 }),
        makeItem({ id: "tie-b", treatmentAppointmentId: "a1", position: 1 }),
        makeItem({ id: "first", treatmentAppointmentId: "a1", position: 0 }),
      ],
    });
    expect(appointmentGroups(model)[0].rows.map((r) => r.item.id)).toEqual([
      "first",
      "tie-a",
      "tie-b",
      "third",
    ]);
  });

  it("does not create two cards for a duplicated appointment id", () => {
    const model = buildPlanPanel({
      plan: makePlan(),
      appointments: [makeAppt({ id: "a1", position: 0 }), makeAppt({ id: "a1", position: 1 })],
      items: [makeItem({ id: "d1", treatmentAppointmentId: "a1" })],
    });
    expect(appointmentGroups(model)).toHaveLength(1);
    expect(renderedIds(model)).toEqual(["d1"]);
    expect(model.reconciliation.balanced).toBe(true);
  });
});

describe("items pointing at an appointment we did not receive", () => {
  const model = buildPlanPanel({
    plan: makePlan(),
    appointments: [makeAppt({ id: "a1", position: 0 })],
    items: [
      makeItem({ id: "ok", treatmentAppointmentId: "a1" }),
      makeItem({ id: "ghost", treatmentAppointmentId: "a-missing" }),
      makeItem({ id: "loose", treatmentAppointmentId: null }),
    ],
  });

  it("keeps items that point at an appointment we did not receive", () => {
    expect(renderedIds(model).sort()).toEqual(["ghost", "loose", "ok"]);
    const bucket = unassignedGroup(model);
    expect(bucket?.rows.map((r) => r.item.id)).toEqual(["ghost", "loose"]);
  });

  it("counts the two reasons separately and says both out loud", () => {
    const bucket = unassignedGroup(model);
    expect(bucket?.counts).toEqual({ noAppointmentId: 1, unknownAppointmentId: 1 });
    expect(bucket?.reason).toContain("not attached");
    expect(bucket?.reason).toContain("was not returned");
  });
});

describe("describeUnassigned", () => {
  it("reads naturally for one item and for many", () => {
    expect(describeUnassigned({ noAppointmentId: 1, unknownAppointmentId: 0 })).toBe(
      "1 item is not attached to an appointment in Dentally, so it has no card. It is listed here in full.",
    );
    expect(describeUnassigned({ noAppointmentId: 83, unknownAppointmentId: 0 })).toBe(
      "83 items are not attached to an appointment in Dentally, so they have no card. They are listed here in full.",
    );
  });

  it("states the unknown-appointment case on its own when it is the only one", () => {
    expect(describeUnassigned({ noAppointmentId: 0, unknownAppointmentId: 2 })).toBe(
      "2 items reference an appointment that was not returned with this plan, so they cannot be placed on a card. They are listed here in full.",
    );
  });

  it("never returns an empty sentence", () => {
    expect(describeUnassigned({ noAppointmentId: 0, unknownAppointmentId: 0 }).length).toBeGreaterThan(0);
  });
});

describe("plan-level totals", () => {
  const items = [
    makeItem({ id: "t1", treatmentAppointmentId: "a1", pricePence: 5_000, durationMin: 10, charged: false }),
    makeItem({ id: "t2", pricePence: 2_500, durationMin: 20, charged: false }),
    makeItem({ id: "t3", pricePence: 1_000, durationMin: 30, charged: true }),
  ];
  const model = buildPlanPanel({
    plan: makePlan({
      privateTreatmentValuePence: 123_45,
      nhsUdaHundredths: 300,
      nhsCompletedUdaHundredths: 156,
    }),
    appointments: [makeAppt({ id: "a1" })],
    items,
  });

  it("comes from the plan's own fields, not from summing the rows", () => {
    // Deliberately different from the item sum (8,500p) so a summing
    // implementation cannot pass by coincidence.
    expect(model.totals.privateTreatmentValuePence).toBe(12_345);
    expect(model.totals.nhsUdaHundredths).toBe(300);
    expect(model.totals.nhsCompletedUdaHundredths).toBe(156);
    expect(model.totals.itemsPricePence).toBe(8_500);
    expect(model.totals.itemsDurationMin).toBe(60);
  });

  it("reports a missing plan figure as null rather than as a plausible zero", () => {
    const m = buildPlanPanel({
      plan: makePlan({ privateTreatmentValuePence: null, nhsUdaHundredths: null }),
      appointments: [],
      items: [],
    });
    expect(m.totals.privateTreatmentValuePence).toBeNull();
    expect(m.totals.nhsUdaHundredths).toBeNull();
  });

  it("sums uncharged from charged === false, over every group including the bucket", () => {
    expect(model.totals.unchargedPence).toBe(7_500);
    expect(model.totals.unchargedItemCount).toBe(2);
  });

  it("still reports an uncharged total of zero — the line renders either way", () => {
    const m = buildPlanPanel({
      plan: makePlan(),
      appointments: [],
      items: [makeItem({ id: "c", pricePence: 4_000, charged: true })],
    });
    expect(m.totals.unchargedPence).toBe(0);
    expect(m.totals.unchargedItemCount).toBe(0);
    expect(m.totals.itemsPricePence).toBe(4_000);
  });

  it("handles the live case where charged is false on every item", () => {
    // 100/100 sampled live items had charged === false. Uncharged == total is
    // the NORMAL reading here, not a bug.
    const all = Array.from({ length: 10 }, (_, i) =>
      makeItem({ id: `a${i}`, pricePence: 111, charged: false }),
    );
    const m = buildPlanPanel({ plan: makePlan(), appointments: [], items: all });
    expect(m.totals.unchargedPence).toBe(m.totals.itemsPricePence);
    expect(m.totals.unchargedItemCount).toBe(10);
  });
});

describe("unreadable figures are counted, never silently summed as zero", () => {
  it("coerces a non-finite price or duration to zero and reports it", () => {
    const model = buildPlanPanel({
      plan: makePlan(),
      appointments: [makeAppt({ id: "a1" })],
      items: [
        makeItem({ id: "bad", treatmentAppointmentId: "a1", pricePence: Number.NaN, durationMin: 15 }),
        makeItem({ id: "good", treatmentAppointmentId: "a1", pricePence: 500, durationMin: 5 }),
      ],
    });
    const card = appointmentGroups(model)[0];
    expect(card.totals.pricePence).toBe(500);
    expect(card.totals.durationMin).toBe(20);
    expect(card.totals.unreadableFigures).toBe(1);
    expect(card.rows).toHaveLength(2); // still rendered
  });
});
