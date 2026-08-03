// ===========================================================================
// THE SEAM BETWEEN THE THREE BUILDS, ASSERTED.
//
// plan-panel-view.ts is where the charting library's model, the Dentally read's
// card headers and the cards' flat rows are joined. It is also the one place in
// this feature where the discriminated union that protects the 83% is flattened
// back into two fields, so it is the one place the finding could be undone.
//
// These tests therefore lean hardest on two things: that the bucket survives the
// flattening with its counted sentence intact, and that no cell on a row is
// filled with something we cannot prove — an invented tooth, a guessed set of
// initials, a record's edit date printed where a reader expects an appointment.
// ===========================================================================

import { describe, it, expect } from "vitest";
import { buildPlanPanel, type PlanAppointment, type PlanHeader, type PlanPanelItem } from "./plan-panel";
import type { PlanCardHeader } from "@/lib/dentally/charting-read";
import {
  PLAN_PANEL_READ_COPY,
  UNNAMED_TREATMENT_LABEL,
  initialsOf,
  planPanelNotices,
  rowDate,
  toPlanPanelView,
  toPlanPanelViews,
  unreadableFiguresNote,
  type PlanPanelSource,
} from "./plan-panel-view";

// --- Fixtures --------------------------------------------------------------

function item(over: Partial<PlanPanelItem> & { id: string }): PlanPanelItem {
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
    nomenclature: "Composite Filling",
    price: 0,
    value: 0,
    durationMin: 15,
    nhsTreatmentCat: null,
    udaBand: null,
    position: 0,
    planId: "plan-1",
    treatmentId: null,
    practitionerId: null,
    paymentPlanId: 2,
    createdAt: "2026-01-04T09:00:00Z",
    updatedAt: "2026-07-30T09:00:00Z",
    treatmentAppointmentId: null,
    pricePence: 4500,
    ...over,
  };
}

function appointment(over: Partial<PlanAppointment> & { id: string }): PlanAppointment {
  return { position: 0, appointmentId: null, notes: null, bookable: true, ...over };
}

function header(over: Partial<PlanCardHeader> & { treatmentAppointmentId: string }): PlanCardHeader {
  return {
    appointmentId: null,
    start: null,
    finish: null,
    durationMin: null,
    state: null,
    practitioner: null,
    practitionerId: null,
    unresolvedReason: null,
    ...over,
  };
}

const PLAN: PlanHeader = {
  id: "688300",
  nickname: "Upper right quadrant",
  completed: false,
  completedAt: null,
  startDate: "2026-01-04",
  endDate: null,
  paymentPlanId: 2,
  practitionerId: null,
  privateTreatmentValuePence: 125_00,
  nhsUdaHundredths: 300,
  nhsCompletedUdaHundredths: 100,
};

/**
 * THE LIVE DISTRIBUTION, not a tidy one: 18 items, 3 of them on a card. That is
 * 17%, which is what the production probe recorded, and it is the shape in which
 * every "render the cards" bug is invisible.
 */
function liveShapedSource(): PlanPanelSource {
  const carded = [
    item({ id: "i-1", treatmentAppointmentId: "ta-1", teeth: [16], pricePence: 4500, durationMin: 30 }),
    item({ id: "i-2", treatmentAppointmentId: "ta-1", pricePence: 0, durationMin: 15, paymentPlanId: 1 }),
    item({ id: "i-3", treatmentAppointmentId: "ta-1", pricePence: 1250, durationMin: 10 }),
  ];
  const loose = Array.from({ length: 15 }, (_, n) =>
    item({ id: `i-${n + 4}`, pricePence: 1000, durationMin: 5, position: n }),
  );
  const appts = [appointment({ id: "ta-1", position: 0, appointmentId: "appt-1", notes: "Bring the shade guide." })];
  return {
    model: buildPlanPanel({ plan: PLAN, appointments: appts, items: [...carded, ...loose] }),
    cardHeaders: {
      "ta-1": header({
        treatmentAppointmentId: "ta-1",
        appointmentId: "appt-1",
        start: "2026-08-02T15:00:00Z",
        practitioner: "Zara Hussain",
        practitionerId: "prac-1",
      }),
    },
    practitioners: {},
    synthetic: false,
  };
}

// --- The finding -----------------------------------------------------------

describe("the unassigned bucket survives the flattening", () => {
  it("carries 15 of 18 rows on the live-shaped plan, and reconciles", () => {
    const view = toPlanPanelView(liveShapedSource());
    expect(view.appointments).toHaveLength(1);
    expect(view.appointments[0].rows).toHaveLength(3);
    expect(view.unassigned).not.toBeNull();
    expect(view.unassigned!.rows).toHaveLength(15);
    expect(view.reconciliation).toEqual({ modelRowCount: 18, viewRowCount: 18, balanced: true });
  });

  it("keeps the library's COUNTED sentence rather than a fixed one", () => {
    const view = toPlanPanelView(liveShapedSource());
    // 15, in words, because the count is the fact that stops a reader concluding
    // three booked lines are the whole plan.
    expect(view.unassigned!.reason).toContain("15 items");
    expect(view.unassigned!.reason).toContain("not attached to an appointment");
  });

  it("distinguishes a dangling appointment id from no appointment at all", () => {
    const items = [
      item({ id: "a", treatmentAppointmentId: null }),
      item({ id: "b", treatmentAppointmentId: "ta-gone" }),
    ];
    const view = toPlanPanelView({
      model: buildPlanPanel({ plan: PLAN, appointments: [], items }),
      cardHeaders: {},
      practitioners: {},
      synthetic: false,
    });
    expect(view.unassigned!.rows).toHaveLength(2);
    // Two different problems with two different fixes, so two clauses.
    expect(view.unassigned!.reason).toContain("not attached to an appointment");
    expect(view.unassigned!.reason).toContain("was not returned with this plan");
  });

  it("never drops a row whose teeth would not parse", () => {
    const view = toPlanPanelView({
      model: buildPlanPanel({
        plan: PLAN,
        appointments: [],
        items: [item({ id: "x", teeth: [], rawTeeth: "UR6 (roots)" })],
      }),
      cardHeaders: {},
      practitioners: {},
      synthetic: false,
    });
    expect(view.unassigned!.rows).toHaveLength(1);
    // The arch cannot draw it, so the row prints what Dentally actually said.
    expect(view.unassigned!.rows[0].toothLabel).toBeNull();
    expect(view.unassigned!.rows[0].rawTeeth).toBe("UR6 (roots)");
  });

  it("reconciles even when every single item is unassigned", () => {
    const items = Array.from({ length: 40 }, (_, n) => item({ id: `z-${n}` }));
    const view = toPlanPanelView({
      model: buildPlanPanel({ plan: PLAN, appointments: [], items }),
      cardHeaders: {},
      practitioners: {},
      synthetic: false,
    });
    expect(view.appointments).toHaveLength(0);
    expect(view.unassigned!.rows).toHaveLength(40);
    expect(view.reconciliation.balanced).toBe(true);
  });

  it("leaves the bucket null only when there is genuinely nothing in it", () => {
    const view = toPlanPanelView({
      model: buildPlanPanel({
        plan: PLAN,
        appointments: [appointment({ id: "ta-1" })],
        items: [item({ id: "only", treatmentAppointmentId: "ta-1" })],
      }),
      cardHeaders: { "ta-1": header({ treatmentAppointmentId: "ta-1" }) },
      practitioners: {},
      synthetic: false,
    });
    expect(view.unassigned).toBeNull();
    expect(view.reconciliation.balanced).toBe(true);
  });
});

// --- The card header -------------------------------------------------------

describe("the card header keeps the read's own sentence", () => {
  it("passes the dangling-id sentence through, naming the id", () => {
    const reason =
      "Dentally links this card to appointment appt-404, which was not in this patient's appointment list. Its date, time and clinician cannot be shown.";
    const view = toPlanPanelView({
      model: buildPlanPanel({
        plan: PLAN,
        appointments: [appointment({ id: "ta-1", appointmentId: "appt-404" })],
        items: [item({ id: "i", treatmentAppointmentId: "ta-1" })],
      }),
      cardHeaders: {
        "ta-1": header({ treatmentAppointmentId: "ta-1", appointmentId: "appt-404", unresolvedReason: reason }),
      },
      practitioners: {},
      synthetic: false,
    });
    // NOT the generic "not linked to a diary appointment": that would tell a
    // clinician the treatment is unbooked when Dentally says it is booked.
    expect(view.appointments[0].unresolvedReason).toBe(reason);
    expect(view.appointments[0].startsAtIso).toBeNull();
  });

  it("takes date and clinician from the diary, never from the treatment_appointment", () => {
    const view = toPlanPanelView(liveShapedSource());
    expect(view.appointments[0].startsAtIso).toBe("2026-08-02T15:00:00Z");
    expect(view.appointments[0].practitioner).toBe("Zara Hussain");
    expect(view.appointments[0].unresolvedReason).toBeNull();
  });

  it("renders position 0 as card number 1, and keeps an unreadable position unnumbered", () => {
    const view = toPlanPanelView({
      model: buildPlanPanel({
        plan: PLAN,
        appointments: [appointment({ id: "ta-a", position: 0 }), appointment({ id: "ta-b", position: Number.NaN })],
        items: [],
      }),
      cardHeaders: {},
      practitioners: {},
      synthetic: false,
    });
    // The card renders position + 1, so 0 here is "Appt. 1".
    expect(view.appointments.map((a) => a.position)).toEqual([0, null]);
  });

  it("calls a card complete only when it holds rows and every one of them is done", () => {
    const build = (items: PlanPanelItem[]) =>
      toPlanPanelView({
        model: buildPlanPanel({ plan: PLAN, appointments: [appointment({ id: "ta-1" })], items }),
        cardHeaders: { "ta-1": header({ treatmentAppointmentId: "ta-1" }) },
        practitioners: {},
        synthetic: false,
      }).appointments[0].completed;

    expect(build([])).toBe(false);
    expect(build([item({ id: "a", treatmentAppointmentId: "ta-1", completed: true })])).toBe(true);
    expect(
      build([
        item({ id: "a", treatmentAppointmentId: "ta-1", completed: true }),
        item({ id: "b", treatmentAppointmentId: "ta-1", completed: false }),
      ]),
    ).toBe(false);
  });
});

// --- Cells that must not be invented ---------------------------------------

describe("no cell states more than Dentally sent", () => {
  it("takes initials from a practitioner's NAME and never from a uuid", () => {
    expect(initialsOf("Zara Hussain")).toBe("ZH");
    expect(initialsOf("Dr Zara Hussain")).toBe("ZH");
    expect(initialsOf("Prof. Aisha Noor Khan")).toBe("AN");
    expect(initialsOf(null)).toBeNull();
    expect(initialsOf("   ")).toBeNull();
  });

  it("leaves initials empty ONLY for a row that names no practitioner at all", () => {
    const view = toPlanPanelView(liveShapedSource());
    // The fixture's loose rows carry practitionerId null, so there is nothing to
    // resolve and nothing to guess: an empty cell is the true answer, and it is the
    // ONLY case in which the cell is empty.
    expect(view.unassigned!.rows.every((r) => r.practitionerInitials === null)).toBe(true);
    expect(view.unassigned!.rows.every((r) => r.practitionerUnresolved === false)).toBe(true);
  });

  it("never falls back to the practitioner id itself", () => {
    // Caught by mutation testing: falling back to the id compiles, type checks, and
    // puts "8f3c..." in the initials column of a clinical record.
    const view = toPlanPanelView({
      model: buildPlanPanel({
        plan: PLAN,
        appointments: [],
        items: [item({ id: "u", practitionerId: "8f3c1d2e-0000-4a11-9c22-b7d5e6f70011" })],
      }),
      cardHeaders: {},
      practitioners: {},
      synthetic: false,
    });
    expect(view.unassigned!.rows[0].practitionerInitials).toBeNull();
    // AND IT DOES NOT GO QUIETLY BLANK EITHER. Dentally named somebody on this line;
    // an empty cell on this table means "Dentally sent nothing here", so a blank
    // would be a false statement about who treated the patient. This assertion is
    // the correction of a test that used to pin the blank as intended behaviour.
    expect(view.unassigned!.rows[0].practitionerUnresolved).toBe(true);
  });

  it("resolves initials for a row worked by a clinician a card DID name", () => {
    const src = liveShapedSource();
    const view = toPlanPanelView({
      ...src,
      model: buildPlanPanel({
        plan: PLAN,
        appointments: [appointment({ id: "ta-1", appointmentId: "appt-1" })],
        items: [item({ id: "i-1", treatmentAppointmentId: "ta-1", practitionerId: "prac-1" })],
      }),
    });
    expect(view.appointments[0].rows[0].practitionerInitials).toBe("ZH");
  });

  // =========================================================================
  // THE 83% CASE. These are the tests the old ones got backwards.
  //
  // The practitioner map used to be built from cardHeaders ALONE — that is, only
  // from clinicians appearing on a RESOLVED DIARY APPOINTMENT of this same plan.
  // 17 of 100 live items sit on an appointment at all, so a plan with no resolved
  // card named nobody on 100% of its rows, and two of the three panels the mock
  // patient renders are exactly that. The suite then PINNED the blank: two tests
  // asserted practitionerInitials === null on rows whose practitioner Dentally had
  // named perfectly well.
  //
  // MUTATION TRIED, and it must fail these three:
  //   const practitioners = new Map<string, string>();   // ignore source.practitioners
  //   for (const header of Object.values(cardHeaders)) { ... }
  // which is the code as it shipped.
  // =========================================================================

  it("names the clinician on a plan with NO resolved appointment card at all", () => {
    // No cards, no diary, nothing resolved: the 83% shape, and the case in which
    // the old implementation was guaranteed to render an empty column.
    const view = toPlanPanelView({
      model: buildPlanPanel({
        plan: PLAN,
        appointments: [],
        items: [
          item({ id: "a", practitionerId: "prac-1" }),
          item({ id: "b", practitionerId: "prac-2" }),
        ],
      }),
      cardHeaders: {},
      practitioners: { "prac-1": "Dana Hale", "prac-2": "Femi Osei" },
      synthetic: false,
    });
    expect(view.appointments).toHaveLength(0);
    expect(view.unassigned!.rows.map((r) => r.practitionerInitials)).toEqual(["DH", "FO"]);
    expect(view.unassigned!.rows.every((r) => r.practitionerUnresolved === false)).toBe(true);
  });

  it("names a clinician the stream knows even when a card names somebody else", () => {
    // A card is booked with one clinician and a line on it can be another's. The
    // initials come from the ITEM'S own practitioner_id, never from the heading
    // above it, or every row of a card would be attributed to whoever it was booked
    // with.
    const view = toPlanPanelView({
      model: buildPlanPanel({
        plan: PLAN,
        appointments: [appointment({ id: "ta-1", appointmentId: "appt-1" })],
        items: [item({ id: "i", treatmentAppointmentId: "ta-1", practitionerId: "prac-2" })],
      }),
      cardHeaders: {
        "ta-1": header({
          treatmentAppointmentId: "ta-1",
          appointmentId: "appt-1",
          start: "2026-08-02T15:00:00Z",
          practitioner: "Zara Hussain",
          practitionerId: "prac-1",
        }),
      },
      practitioners: { "prac-1": "Dana Hale", "prac-2": "Femi Osei" },
      synthetic: false,
    });
    expect(view.appointments[0].practitioner).toBe("Zara Hussain");
    expect(view.appointments[0].rows[0].practitionerInitials).toBe("FO");
  });

  it("degrades VISIBLY when the practitioner read failed, never to 'no practitioner'", () => {
    // A failed clinician read hands over an empty map. The rows still carry a
    // practitioner_id, so the cell must say we could not look the name up rather
    // than going blank, which on this table means Dentally sent nothing.
    const view = toPlanPanelView({
      model: buildPlanPanel({
        plan: PLAN,
        appointments: [],
        items: [item({ id: "a", practitionerId: "prac-1" }), item({ id: "b", practitionerId: null })],
      }),
      cardHeaders: {},
      practitioners: {},
      synthetic: false,
    });
    const [named, unnamed] = view.unassigned!.rows;
    expect(named.practitionerInitials).toBeNull();
    expect(named.practitionerUnresolved).toBe(true);
    // And the row that genuinely names nobody stays the OTHER state. Collapsing the
    // two would put the marker on every line of a plan Dentally never attributed.
    expect(unnamed.practitionerUnresolved).toBe(false);
    // The screen says so in words, above the panels.
    expect(
      planPanelNotices({
        balanced: true,
        truncated: false,
        truncatedSupporting: false,
        health: { items: "ok", appointments: "ok", diary: "ok", practitioners: "failed" },
      }),
    ).toEqual([PLAN_PANEL_READ_COPY.practitionersFailed]);
  });

  it("prefers the practitioners stream over a card's copy of the same name", () => {
    // The roster is the practice's own record of who somebody is; a diary row's
    // `practitioner` string is a copy of it. The fallback fills gaps and never
    // overwrites.
    const view = toPlanPanelView({
      model: buildPlanPanel({
        plan: PLAN,
        appointments: [appointment({ id: "ta-1", appointmentId: "appt-1" })],
        items: [item({ id: "i", treatmentAppointmentId: "ta-1", practitionerId: "prac-1" })],
      }),
      cardHeaders: {
        "ta-1": header({
          treatmentAppointmentId: "ta-1",
          appointmentId: "appt-1",
          start: "2026-08-02T15:00:00Z",
          practitioner: "Zara Hussain",
          practitionerId: "prac-1",
        }),
      },
      practitioners: { "prac-1": "Dana Hale" },
      synthetic: false,
    });
    expect(view.appointments[0].rows[0].practitionerInitials).toBe("DH");
  });

  it("dates a row from its card, or from its completion, and otherwise not at all", () => {
    const card = "2026-08-02T15:00:00Z";
    expect(rowDate(item({ id: "a" }), card)).toBe(card);
    // NOT updatedAt. The fixture's updatedAt is a record edit date, and printing it
    // in the date column would say the work happens the day somebody fixed a typo.
    expect(rowDate(item({ id: "b", updatedAt: "2026-07-30T09:00:00Z" }), null)).toBeNull();
    expect(rowDate(item({ id: "c", completedAt: "2026-05-01T10:00:00Z" }), null)).toBe(
      "2026-05-01T10:00:00Z",
    );
  });

  it("names an item with no wording rather than leaving the name column blank", () => {
    const view = toPlanPanelView({
      model: buildPlanPanel({
        plan: PLAN,
        appointments: [],
        items: [item({ id: "n", nomenclature: null }), item({ id: "m", nomenclature: "   " })],
      }),
      cardHeaders: {},
      practitioners: {},
      synthetic: false,
    });
    expect(view.unassigned!.rows.map((r) => r.name)).toEqual([
      UNNAMED_TREATMENT_LABEL,
      UNNAMED_TREATMENT_LABEL,
    ]);
  });

  it("converts teeth through the FDI library and never in a component", () => {
    const view = toPlanPanelView({
      model: buildPlanPanel({
        plan: PLAN,
        appointments: [],
        items: [item({ id: "t", teeth: [16, 26] })],
      }),
      cardHeaders: {},
      practitioners: {},
      synthetic: false,
    });
    expect(view.unassigned!.rows[0].toothLabel).toBe("UR6, UL6");
  });

  it("prints Dentally's surface NUMBERS when that is the only form it sent", () => {
    const view = toPlanPanelView({
      model: buildPlanPanel({
        plan: PLAN,
        appointments: [],
        items: [item({ id: "s", teeth: [16], surfaceIndices: [3, 8] })],
      }),
      cardHeaders: {},
      practitioners: {},
      synthetic: false,
    });
    // Never "distal and disto-buccal": nothing public says how Dentally orients a
    // quadrant, so a named surface would be a wrong-surface clinical claim.
    expect(view.unassigned!.rows[0].surfacesLabel).toBe("surfaces 3, 8");
  });

  it("keeps funding unresolved rather than defaulting an unknown plan id to Private", () => {
    const view = toPlanPanelView({
      model: buildPlanPanel({
        plan: PLAN,
        appointments: [],
        items: [item({ id: "f", paymentPlanId: 999_999 })],
      }),
      cardHeaders: {},
      practitioners: {},
      synthetic: false,
    });
    expect(view.unassigned!.rows[0].funding).toBe("unknown");
  });
});

// --- Money -----------------------------------------------------------------

describe("money", () => {
  it("totals the rows on screen, in pence, and never rounds a penny away", () => {
    const view = toPlanPanelView({
      model: buildPlanPanel({
        plan: PLAN,
        appointments: [],
        items: [
          item({ id: "a", pricePence: 2679 }),
          item({ id: "b", pricePence: 2680 }),
          item({ id: "c", pricePence: 1 }),
        ],
      }),
      cardHeaders: {},
      practitioners: {},
      synthetic: false,
    });
    expect(view.totals.itemsPricePence).toBe(5360);
    // charged is false on all three, which is the live reading, so uncharged equals
    // the total. That is the data, not a bug.
    expect(view.totals.unchargedPence).toBe(5360);
  });

  it("keeps a plan value Dentally did not send as NULL, never as a plausible zero", () => {
    const view = toPlanPanelView({
      model: buildPlanPanel({
        plan: { ...PLAN, privateTreatmentValuePence: null, nhsUdaHundredths: null, nhsCompletedUdaHundredths: null },
        appointments: [],
        items: [item({ id: "a", pricePence: 100 })],
      }),
      cardHeaders: {},
      practitioners: {},
      synthetic: false,
    });
    expect(view.totals.privateTreatmentValuePence).toBeNull();
    expect(view.totals.nhsUdaHundredths).toBeNull();
    // A real zero is a figure and stays one.
    expect(view.totals.unchargedPence).toBe(100);
  });

  it("carries the plan's own value BESIDE the sum of the rows, not instead of it", () => {
    const view = toPlanPanelView(liveShapedSource());
    // The plan says £125.00; the rows on screen come to £207.50 (4500 + 0 + 1250 on
    // the card, plus fifteen loose rows at 1000). The two disagree, and the panel
    // shows both rather than picking one: substituting the plan's figure for the sum
    // would hide exactly the case where a line is missing from the screen.
    expect(view.totals.privateTreatmentValuePence).toBe(12_500);
    expect(view.totals.itemsPricePence).toBe(4500 + 0 + 1250 + 15 * 1000);
  });

  it("carries a figure it could not read as NULL, and never as the string NaN", () => {
    // plan-panel.ts has always counted these rows so "the footer can caveat itself",
    // and nothing carried the count this far. The row rendered "NaN min £NaN" while
    // the card footer silently excluded it and said nothing.
    const view = toPlanPanelView({
      model: buildPlanPanel({
        plan: PLAN,
        appointments: [],
        items: [
          item({ id: "bad", pricePence: Number.NaN, durationMin: Number.NaN }),
          item({ id: "good", pricePence: 0, durationMin: 0 }),
        ],
      }),
      cardHeaders: {},
      practitioners: {},
      synthetic: false,
    });
    const [bad, good] = view.unassigned!.rows;
    expect(bad.pricePence).toBeNull();
    expect(bad.durationMin).toBeNull();
    // A REAL ZERO IS NOT NULL. A £0.00, 0 minute line is an ordinary row on a plan
    // (an image inside a band, a bridge abutment) and must keep printing as one.
    expect(good.pricePence).toBe(0);
    expect(good.durationMin).toBe(0);
    // And the footer now says it is short rather than presenting a partial sum.
    expect(view.unassigned!.totals.unreadableFigures).toBe(1);
    expect(unreadableFiguresNote(view.unassigned!.totals.unreadableFigures)).toContain("1 line");
  });

  it("says nothing at all when every figure on a group was readable", () => {
    // A caveat that is always on is a caveat nobody reads.
    const view = toPlanPanelView(liveShapedSource());
    expect(view.unassigned!.totals.unreadableFigures).toBe(0);
    expect(unreadableFiguresNote(0)).toBeNull();
    expect(unreadableFiguresNote(Number.NaN)).toBeNull();
  });

  it("keeps UDA figures in hundredths and apart from money", () => {
    const view = toPlanPanelView(liveShapedSource());
    expect(view.totals.nhsUdaHundredths).toBe(300);
    expect(view.totals.nhsCompletedUdaHundredths).toBe(100);
  });
});

// --- Two plans on one page -------------------------------------------------

describe("DOM id namespacing", () => {
  it("gives every panel its own prefix, so two plans never share an id", () => {
    const a = toPlanPanelView({ ...liveShapedSource(), synthetic: false });
    const b = toPlanPanelView({
      model: buildPlanPanel({ plan: { ...PLAN, id: "688301" }, appointments: [], items: [] }),
      cardHeaders: {},
      practitioners: {},
      synthetic: false,
    });
    expect(a.domId).toBe("chart-plan-688300");
    expect(b.domId).toBe("chart-plan-688301");
    expect(a.domId).not.toBe(b.domId);
  });

  it("gives the synthetic panel, whose plan id is empty, a prefix of its own", () => {
    const view = toPlanPanelView({
      model: buildPlanPanel({
        plan: { ...PLAN, id: "", nickname: "Treatment not shown against a plan" },
        appointments: [],
        items: [item({ id: "orphan", planId: null })],
      }),
      cardHeaders: {},
      practitioners: {},
      synthetic: true,
    });
    // "chart-plan-" with nothing after it is a prefix every other panel's ids also
    // start with, which is how an aria-describedby ends up resolving to the wrong
    // panel's sentence.
    expect(view.domId).toBe("chart-plan-unfiled");
    expect(view.synthetic).toBe(true);
  });

  it("maps every panel of a read, in order", () => {
    const views = toPlanPanelViews([
      liveShapedSource(),
      {
        model: buildPlanPanel({ plan: { ...PLAN, id: "" }, appointments: [], items: [] }),
        cardHeaders: {},
        practitioners: {},
        synthetic: true,
      },
    ]);
    expect(views.map((v) => v.synthetic)).toEqual([false, true]);
  });
});

// --- The read's own caveats -------------------------------------------------

describe("planPanelNotices", () => {
  const ok = {
    balanced: true,
    truncated: false,
    truncatedSupporting: false,
    health: { items: "ok", appointments: "ok", diary: "ok", practitioners: "ok" },
  } as const;

  it("says nothing at all on a clean read", () => {
    expect(planPanelNotices(ok)).toEqual([]);
  });

  it("puts the incomplete-screen sentence first, above every other caveat", () => {
    const notices = planPanelNotices({
      ...ok,
      balanced: false,
      truncated: true,
      health: { items: "ok", appointments: "failed", diary: "failed", practitioners: "ok" },
    });
    expect(notices[0]).toContain("could not be placed on this screen");
    expect(notices).toHaveLength(4);
  });

  it("distinguishes a failed appointments read from a failed diary read", () => {
    const appts = planPanelNotices({ ...ok, health: { items: "ok", appointments: "failed", diary: "ok", practitioners: "ok" } });
    const diary = planPanelNotices({ ...ok, health: { items: "ok", appointments: "ok", diary: "failed", practitioners: "ok" } });
    expect(appts[0]).not.toBe(diary[0]);
    // One means every line loses its card; the other means the cards lose their
    // dates. Telling a clinician the wrong one sends them to the wrong screen.
    expect(appts[0]).toContain("without its appointment card");
    expect(diary[0]).toContain("no date, time or clinician");
  });
});
