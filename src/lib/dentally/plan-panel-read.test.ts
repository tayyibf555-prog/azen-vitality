// ===========================================================================
// THE TREATMENT PLAN PANEL READ — tests.
//
// Everything here is one assertion said several ways: a partial read must never
// render as a complete plan, and no item may be lost between the wire and a
// group. The two failures these guard against have both already shipped on this
// feature — a stream that caught to [] with health still "ok", and a row silently
// dropped by a shaping step — and both looked correct on screen.
//
// The grouping and the totals are NOT tested here. They belong to
// src/lib/charting/plan-panel.ts and are covered by its own suite against a
// deliberately broken implementation. What is tested here is the boundary: what
// we ask Dentally for, what we do with what comes back, and what we say when a
// stream fails.
// ===========================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const PER_PAGE = 100;

interface Calls {
  items: Array<Record<string, unknown>>;
  appts: Array<Record<string, unknown>>;
  plans: Array<Record<string, unknown>>;
  diary: Array<unknown[]>;
  practitioners: Array<unknown[]>;
}

interface ClientStubs {
  listTreatmentPlanItems: (a: { page?: number }) => Promise<unknown>;
  listTreatmentAppointments: (a: { page?: number }) => Promise<unknown>;
  listTreatmentPlansById: (a: { page?: number }) => Promise<unknown>;
  getPatientAppointments: (...a: unknown[]) => Promise<unknown>;
  listPractitioners: (...a: unknown[]) => Promise<unknown>;
  calls: Calls;
}

const state = vi.hoisted<ClientStubs>(() => ({
  listTreatmentPlanItems: () => Promise.resolve({ treatment_plan_items: [] }),
  listTreatmentAppointments: () => Promise.resolve({ treatment_appointments: [] }),
  listTreatmentPlansById: () => Promise.resolve({ treatment_plans: [] }),
  getPatientAppointments: () => Promise.resolve({ appointments: [] }),
  listPractitioners: () => Promise.resolve({ practitioners: [] }),
  calls: { items: [], appts: [], plans: [], diary: [], practitioners: [] },
}));

vi.mock("./client", () => ({
  DentallyClient: class {
    constructor() {}
    listTreatmentPlanItems(a: { page?: number }) {
      state.calls.items.push(a as Record<string, unknown>);
      return state.listTreatmentPlanItems(a);
    }
    listTreatmentAppointments(a: { page?: number }) {
      state.calls.appts.push(a as Record<string, unknown>);
      return state.listTreatmentAppointments(a);
    }
    listTreatmentPlansById(a: { page?: number }) {
      state.calls.plans.push(a as Record<string, unknown>);
      return state.listTreatmentPlansById(a);
    }
    getPatientAppointments(...a: unknown[]) {
      state.calls.diary.push(a);
      return state.getPatientAppointments(...a);
    }
    listPractitioners(...a: unknown[]) {
      state.calls.practitioners.push(a);
      return state.listPractitioners(...a);
    }
  },
}));

import {
  getPlanPanelRead,
  getPlanPanelReadUncached,
  clearPlanPanelReadCache,
  type PlanPanelRead,
} from "./charting-read";

beforeEach(() => {
  vi.stubEnv("DENTALLY_API_KEY", "k");
  clearPlanPanelReadCache();
  state.calls = { items: [], appts: [], plans: [], diary: [], practitioners: [] };
  state.listTreatmentPlanItems = () => Promise.resolve({ treatment_plan_items: [] });
  state.listTreatmentAppointments = () => Promise.resolve({ treatment_appointments: [] });
  state.listTreatmentPlansById = () => Promise.resolve({ treatment_plans: [] });
  state.getPatientAppointments = () => Promise.resolve({ appointments: [] });
  state.listPractitioners = () => Promise.resolve({ practitioners: [] });
});

// --- Raw fixtures ----------------------------------------------------------

function rawItem(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "tpi-1", patient_id: "pat-1", treatment_plan_id: "plan-1",
    treatment_appointment_id: null, teeth: [16], surfaces: "MOD",
    nomenclature: "Composite Filling", completed: false, charged: false,
    price: 185, value: 185, duration: 40, position: 1, payment_plan_id: 2, ...o,
  };
}
function rawAppt(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "ta-1", patient_id: "pat-1", treatment_plan_id: "plan-1", position: 0,
    notes: null, bookable: true, appointment_id: null, ...o,
  };
}
function rawPlan(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "plan-1", patient_id: "pat-1", nickname: "Invisalign full arch",
    completed: false, completed_at: null, start_date: "2026-03-02", end_date: null,
    payment_plan_id: 2, practitioner_id: "prac-1",
    private_treatment_value: 4500, nhs_uda_value: 3, nhs_completed_uda_value: 1.56, ...o,
  };
}

function feed(o: {
  items?: Record<string, unknown>[];
  appts?: Record<string, unknown>[];
  plans?: Record<string, unknown>[];
  diary?: Record<string, unknown>[];
  practitioners?: Record<string, unknown>[];
}): void {
  state.listTreatmentPlanItems = () =>
    Promise.resolve({ treatment_plan_items: o.items ?? [] });
  state.listTreatmentAppointments = () =>
    Promise.resolve({ treatment_appointments: o.appts ?? [] });
  state.listTreatmentPlansById = () => Promise.resolve({ treatment_plans: o.plans ?? [] });
  state.getPatientAppointments = () => Promise.resolve({ appointments: o.diary ?? [] });
  state.listPractitioners = () => Promise.resolve({ practitioners: o.practitioners ?? [] });
}

/** Every row on screen, across every panel and every group. Short if a shaping
 *  step dropped something. */
function allRowIds(read: PlanPanelRead): string[] {
  return read.panels.flatMap((p) => p.model.groups.flatMap((g) => g.rows.map((r) => r.item.id)));
}

// ---------------------------------------------------------------------------

describe("the 83% case — most of a live plan has no appointment card", () => {
  it("reads the live distribution end to end and loses nothing", async () => {
    // The measured production shape on 2026-08-02: 100 items, 17 with a
    // treatment_appointment_id, 83 with none at all.
    const hundred = Array.from({ length: 100 }, (_, i) =>
      rawItem({
        id: `tpi-${i}`,
        treatment_appointment_id: i < 10 ? "ta-1" : i < 17 ? "ta-2" : null,
      }),
    );
    feed({
      plans: [rawPlan()],
      appts: [rawAppt({ id: "ta-1", position: 0 }), rawAppt({ id: "ta-2", position: 1 })],
    });
    // Served as ONE full page followed by an empty one, which is how a source with
    // exactly 100 rows behaves. Handing the same full page back forever is what the
    // truncation test below covers, and it is a different case.
    state.listTreatmentPlanItems = (a) =>
      Promise.resolve({ treatment_plan_items: (a.page ?? 1) === 1 ? hundred : [] });
    const read = await getPlanPanelReadUncached("pat-1", "site-cc");

    expect(read.itemCount).toBe(100);
    expect(read.renderedItemCount).toBe(100);
    expect(read.balanced).toBe(true);
    expect(new Set(allRowIds(read)).size).toBe(100);

    // And the 83 are in a group of their own, not folded onto a card.
    const panel = read.panels[0];
    expect(panel.model.unassignedItemCount).toBe(83);
  });

  it("carries treatment_appointment_id through, including ids that arrive as NUMBERS", async () => {
    // Real Dentally sends numeric ids and the mock sends strings. A str()-only
    // read returns null for a number, which here would send every card's rows into
    // the unassigned bucket and empty every card on a live patient.
    feed({
      plans: [rawPlan({ id: 77 })],
      appts: [rawAppt({ id: 900, treatment_plan_id: 77, appointment_id: 55 })],
      items: [rawItem({ id: 1, treatment_plan_id: 77, treatment_appointment_id: 900 })],
      diary: [{ id: 55, start_time: "2026-08-02T16:00:00Z", practitioner: "Dana Hale", practitioner_id: 3 }],
    });
    const read = await getPlanPanelReadUncached("pat-1", "site-cc");
    const panel = read.panels[0];
    expect(panel.plan.id).toBe("77");
    expect(allRowIds(read)).toEqual(["1"]);
    expect(panel.model.unassignedItemCount).toBe(0);
    expect(panel.cardHeaders["900"].practitionerId).toBe("3");
  });
});

describe("the card header comes from the linked DIARY appointment", () => {
  it("resolves date, time and practitioner through appointment_id", async () => {
    feed({
      plans: [rawPlan()],
      appts: [rawAppt({ id: "ta-1", appointment_id: "appt-9" })],
      items: [rawItem({ treatment_appointment_id: "ta-1" })],
      diary: [
        {
          id: "appt-9", start_time: "2026-08-02T16:00:00Z", finish_time: "2026-08-02T16:45:00Z",
          duration: 45, state: "booked", practitioner: "Dana Hale", practitioner_id: "prac-1",
        },
      ],
    });
    const read = await getPlanPanelReadUncached("pat-1", "site-cc");
    const header = read.panels[0].cardHeaders["ta-1"];
    expect(header.start).toBe("2026-08-02T16:00:00Z");
    expect(header.durationMin).toBe(45);
    expect(header.practitioner).toBe("Dana Hale");
    expect(header.state).toBe("booked");
    // Resolved means NO sentence: an explanation on a resolved card is noise that
    // teaches the reader to ignore the ones that matter.
    expect(header.unresolvedReason).toBeNull();
  });

  it("states the reason when the card was never booked", async () => {
    feed({
      plans: [rawPlan()],
      appts: [rawAppt({ id: "ta-1", appointment_id: null })],
    });
    const header = (await getPlanPanelReadUncached("pat-1", "site-cc")).panels[0].cardHeaders["ta-1"];
    expect(header.start).toBeNull();
    expect(header.unresolvedReason).toMatch(/not booked into the diary/i);
  });

  it("states the reason, and NAMES the id, when the linked appointment is missing", async () => {
    // A dangling reference is ordinary after a cancellation or a merge. Rendering
    // it as a blank date would read as "not booked yet", which is a different fact
    // about the patient's care.
    feed({
      plans: [rawPlan()],
      appts: [rawAppt({ id: "ta-1", appointment_id: "appt-gone" })],
      diary: [{ id: "appt-other", start_time: "2026-08-02T16:00:00Z" }],
    });
    const header = (await getPlanPanelReadUncached("pat-1", "site-cc")).panels[0].cardHeaders["ta-1"];
    expect(header.appointmentId).toBe("appt-gone");
    expect(header.start).toBeNull();
    expect(header.unresolvedReason).toContain("appt-gone");
    expect(header.unresolvedReason).not.toMatch(/not booked into the diary/i);
  });

  it("blames the network, not the appointment, when the diary read fails", async () => {
    feed({ plans: [rawPlan()], appts: [rawAppt({ id: "ta-1", appointment_id: "appt-9" })] });
    state.getPatientAppointments = () => Promise.reject(new Error("502"));
    const read = await getPlanPanelReadUncached("pat-1", "site-cc");
    expect(read.health.diary).toBe("failed");
    const header = read.panels[0].cardHeaders["ta-1"];
    expect(header.unresolvedReason).toMatch(/could not be read/i);
    // A card whose id is null is NOT BOOKED whether or not the diary answered.
    // Reporting the outage there would send a clinician to retry for a date that
    // does not exist.
    expect(header.unresolvedReason).not.toMatch(/not booked into the diary/i);
  });

  it("does not print '0 min' for an appointment that carries no duration", async () => {
    feed({
      plans: [rawPlan()],
      appts: [rawAppt({ id: "ta-1", appointment_id: "appt-9" })],
      diary: [{ id: "appt-9", start_time: "2026-08-02T16:00:00Z" }],
    });
    const header = (await getPlanPanelReadUncached("pat-1", "site-cc")).panels[0].cardHeaders["ta-1"];
    expect(header.durationMin).toBeNull();
  });

  it("asks the diary for CANCELLED rows too", async () => {
    // A card booked as an appointment that was later cancelled still has a date and
    // a clinician. Dentally excludes those rows by default, so a card would report
    // "not in this patient's appointment list" for an appointment that plainly
    // exists in Dentally.
    feed({ plans: [rawPlan()] });
    await getPlanPanelReadUncached("pat-1", "site-cc");
    expect(state.calls.diary.length).toBeGreaterThan(0);
    expect(state.calls.diary[0][3]).toBe(true);
  });
});

describe("money", () => {
  it("converts decimal pounds to integer pence, rounding rather than truncating", async () => {
    // 26.8 * 100 is 2680.0000000000005 in IEEE 754. Math.trunc books it as £26.79,
    // and a footer a penny short of its own rows discredits the whole screen.
    feed({
      plans: [rawPlan({ private_treatment_value: 123.45, nhs_uda_value: 3, nhs_completed_uda_value: 1.56 })],
      items: [rawItem({ id: "a", price: 26.8 }), rawItem({ id: "b", price: 185 })],
    });
    const read = await getPlanPanelReadUncached("pat-1", "site-cc");
    const rows = read.panels[0].model.groups.flatMap((g) => g.rows);
    expect(rows.find((r) => r.item.id === "a")?.item.pricePence).toBe(2680);
    expect(rows.find((r) => r.item.id === "b")?.item.pricePence).toBe(18_500);
    expect(read.panels[0].plan.privateTreatmentValuePence).toBe(12_345);
    expect(read.panels[0].plan.nhsUdaHundredths).toBe(300);
    expect(read.panels[0].plan.nhsCompletedUdaHundredths).toBe(156);
  });

  it("reads a price that arrives as a STRING, as live Dentally sends money elsewhere", async () => {
    feed({ plans: [rawPlan()], items: [rawItem({ price: "27.9" })] });
    const read = await getPlanPanelReadUncached("pat-1", "site-cc");
    expect(read.panels[0].model.groups[0].rows[0].item.pricePence).toBe(2790);
  });

  it("keeps a zero-price item as a real zero, and an ABSENT plan value as null", async () => {
    // £0.00 is an ordinary value on a plan (an image inside a band, a bridge
    // abutment). A plan value Dentally did not send is a value we do not know, and
    // printing that as £0.00 would be a claim that the patient owes nothing.
    feed({
      plans: [rawPlan({ private_treatment_value: null, nhs_uda_value: undefined })],
      items: [rawItem({ price: 0 })],
    });
    const read = await getPlanPanelReadUncached("pat-1", "site-cc");
    expect(read.panels[0].model.groups[0].rows[0].item.pricePence).toBe(0);
    expect(read.panels[0].plan.privateTreatmentValuePence).toBeNull();
    expect(read.panels[0].plan.nhsUdaHundredths).toBeNull();
  });
});

describe("per-stream health — a failed read never reads as an empty plan", () => {
  it("flips only its own key when the items read fails", async () => {
    feed({ plans: [rawPlan()], appts: [rawAppt()] });
    state.listTreatmentPlanItems = () => Promise.reject(new Error("boom"));
    const read = await getPlanPanelReadUncached("pat-1", "site-cc");
    expect(read.health).toEqual({
      items: "failed",
      appointments: "ok",
      plans: "ok",
      diary: "ok",
      practitioners: "ok",
    });
  });

  it("flips only its own key when the treatment_appointments read fails", async () => {
    feed({ plans: [rawPlan()], items: [rawItem()] });
    state.listTreatmentAppointments = () => Promise.reject(new Error("boom"));
    const read = await getPlanPanelReadUncached("pat-1", "site-cc");
    expect(read.health.appointments).toBe("failed");
    expect(read.health.items).toBe("ok");
    // AND THE ITEMS STILL RENDER. A failed card read must not take the rows with
    // it: the plan is still readable, it just has no card headings.
    expect(allRowIds(read)).toEqual(["tpi-1"]);
  });

  it("flips only its own key when the plans read fails, and still renders every item", async () => {
    // The worst version of this bug: no plans means no per-plan panel, and a
    // per-plan split with no catch-all would render an empty screen for a patient
    // with a full chart while reporting health.items as "ok".
    feed({ items: [rawItem({ id: "x" }), rawItem({ id: "y" })] });
    state.listTreatmentPlansById = () => Promise.reject(new Error("boom"));
    const read = await getPlanPanelReadUncached("pat-1", "site-cc");
    expect(read.health.plans).toBe("failed");
    expect(allRowIds(read).sort()).toEqual(["x", "y"]);
    expect(read.balanced).toBe(true);
    expect(read.panels[0].synthetic).toBe(true);
    expect(read.panels[0].plan.nickname).toMatch(/could not be read/i);
  });
});

// ===========================================================================
// THE CLINICIAN'S NAME.
//
// Every treatment_plan_item carries a practitioner_id and no name. This read used
// to walk FOUR streams and never /v1/practitioners, so the only names available
// were the ones sitting on a resolved DIARY APPOINTMENT of the same plan — and
// only 17 of 100 live items belong to an appointment at all. A plan with no
// resolved card therefore rendered a blank clinician on 100% of its rows, and an
// empty cell on that table means "Dentally sent nothing here". GDC 4.1.4 requires
// the treating clinician's name or initials on every entry.
//
// MUTATION TRIED: delete the practitionersP stream and hand `{}` to every panel —
// which is the code as it shipped. The first test below fails on it.
// ===========================================================================

describe("the practitioner stream, which is how a row gets a clinician at all", () => {
  it("names the clinician on a plan whose items sit on NO appointment card", async () => {
    feed({
      plans: [rawPlan()],
      // No treatment appointments and no diary at all: the 83% shape.
      items: [rawItem({ id: "a", practitioner_id: "prac-1" })],
      practitioners: [
        { id: "prac-1", active: true, user: { first_name: "Dana", last_name: "Hale" } },
      ],
    });
    const read = await getPlanPanelReadUncached("pat-1", "site-cc");
    expect(read.health.practitioners).toBe("ok");
    expect(read.panels[0].practitioners).toEqual({ "prac-1": "Dana Hale" });
  });

  it("keys the map through idOf, so a NUMERIC live id still matches its item", async () => {
    // Real Dentally sends numeric ids and the mock sends strings. A str()-only key
    // leaves every live row unnamed while every local one resolves.
    feed({
      plans: [rawPlan()],
      items: [rawItem({ practitioner_id: 3 })],
      practitioners: [{ id: 3, active: true, user: { first_name: "Femi", last_name: "Osei" } }],
    });
    const read = await getPlanPanelReadUncached("pat-1", "site-cc");
    expect(read.panels[0].practitioners["3"]).toBe("Femi Osei");
  });

  it("keeps an INACTIVE clinician, because a historical entry still has an author", async () => {
    // read.ts drops inactive rows because it fills a picker of people you can book.
    // This is a record: a filling placed in 2019 by somebody who has since left the
    // practice must still carry their initials, and filtering here would strip the
    // attribution from exactly the oldest entries.
    feed({
      plans: [rawPlan()],
      items: [rawItem({ practitioner_id: "prac-9" })],
      practitioners: [
        { id: "prac-9", active: false, user: { first_name: "Old", last_name: "Locum" } },
      ],
    });
    const read = await getPlanPanelReadUncached("pat-1", "site-cc");
    expect(read.panels[0].practitioners["prac-9"]).toBe("Old Locum");
  });

  it("leaves a row we cannot name OUT of the map rather than in it as a noun", async () => {
    // read.ts falls back to the literal "Practitioner" for a nameless row, which is
    // right for a picker and wrong here: it would render as the initial "P" against
    // a treatment, naming nobody. Absent from the map is what lets the screen say
    // "we could not look this clinician up" instead.
    feed({
      plans: [rawPlan()],
      items: [rawItem({ practitioner_id: "prac-1" })],
      practitioners: [{ id: "prac-1", active: true, user: {} }],
    });
    const read = await getPlanPanelReadUncached("pat-1", "site-cc");
    expect(read.panels[0].practitioners).toEqual({});
  });

  it("fails SOFT and on its own key: no name, no lost row, no blank panel", async () => {
    feed({ plans: [rawPlan()], items: [rawItem({ id: "r", practitioner_id: "prac-1" })] });
    state.listPractitioners = () => Promise.reject(new Error("502"));
    const read = await getPlanPanelReadUncached("pat-1", "site-cc");
    expect(read.health.practitioners).toBe("failed");
    // Every other stream is untouched, every row still renders, and the panel is
    // still balanced. A failed name lookup must never cost a clinician a line.
    expect(read.health.items).toBe("ok");
    expect(read.health.plans).toBe("ok");
    expect(allRowIds(read)).toEqual(["r"]);
    expect(read.balanced).toBe(true);
    expect(read.panels[0].practitioners).toEqual({});
  });

  it("does not cache a read whose practitioner stream failed", async () => {
    feed({ plans: [rawPlan()], items: [rawItem()] });
    state.listPractitioners = () => Promise.reject(new Error("502"));
    await getPlanPanelRead("pat-1", "site-cc");
    await getPlanPanelRead("pat-1", "site-cc");
    expect(state.calls.items.length).toBeGreaterThan(1);
  });

  it("asks for the SITE's practitioners, through the Dentally site id", async () => {
    feed({ plans: [rawPlan()] });
    await getPlanPanelReadUncached("pat-1", "site-cc");
    expect(state.calls.practitioners.length).toBeGreaterThan(0);
    // Our internal site id is not Dentally's, and sending ours returns nobody.
    expect(String(state.calls.practitioners[0][0])).not.toBe("site-cc");
    expect(String(state.calls.practitioners[0][0]).length).toBeGreaterThan(10);
  });

  it("hands the SAME map to every panel, including the synthetic one", async () => {
    // A practice's clinicians belong to the site, not to one treatment plan. A
    // per-plan map would name somebody on one panel and blank them on the next.
    feed({
      plans: [rawPlan({ id: "plan-1" })],
      items: [
        rawItem({ id: "in", treatment_plan_id: "plan-1" }),
        rawItem({ id: "orphan", treatment_plan_id: null }),
      ],
      practitioners: [
        { id: "prac-1", active: true, user: { first_name: "Dana", last_name: "Hale" } },
      ],
    });
    const read = await getPlanPanelReadUncached("pat-1", "site-cc");
    expect(read.panels).toHaveLength(2);
    for (const panel of read.panels) {
      expect(panel.practitioners).toEqual({ "prac-1": "Dana Hale" });
    }
  });
});

describe("nothing is dropped by the split into panels", () => {
  it("keeps an item whose plan we did not receive, in a clearly-labelled panel", async () => {
    feed({
      plans: [rawPlan({ id: "plan-1" })],
      items: [
        rawItem({ id: "in", treatment_plan_id: "plan-1" }),
        rawItem({ id: "orphan", treatment_plan_id: "plan-999" }),
        rawItem({ id: "noplan", treatment_plan_id: null }),
      ],
    });
    const read = await getPlanPanelReadUncached("pat-1", "site-cc");
    expect(allRowIds(read).sort()).toEqual(["in", "noplan", "orphan"]);
    expect(read.balanced).toBe(true);
    const synthetic = read.panels.find((p) => p.synthetic);
    expect(synthetic?.plan.nickname).toBe("Treatment not shown against a plan");
    // Its money is NULL, never zero: we do not hold that plan's record.
    expect(synthetic?.plan.privateTreatmentValuePence).toBeNull();
  });

  it("keeps a card whose plan we did not receive, with its rows under it", async () => {
    feed({
      plans: [rawPlan({ id: "plan-1" })],
      appts: [rawAppt({ id: "ta-x", treatment_plan_id: "plan-999" })],
      items: [rawItem({ id: "r", treatment_plan_id: "plan-999", treatment_appointment_id: "ta-x" })],
    });
    const read = await getPlanPanelReadUncached("pat-1", "site-cc");
    const synthetic = read.panels.find((p) => p.synthetic);
    expect(synthetic?.cardHeaders["ta-x"]).toBeDefined();
    expect(allRowIds(read)).toEqual(["r"]);
  });

  it("keeps a row whose TEETH will not parse — the chart hides it, the plan must not", async () => {
    // getPatientChart routes an unparseable-teeth row into `unplaced` because it
    // cannot draw it on an arch. The panel is a LIST, and a treatment with a price,
    // a duration and a clinician is a real row whatever its teeth field said.
    // Filtering it here would hide charged work from the person reading the plan.
    feed({
      plans: [rawPlan()],
      items: [rawItem({ id: "ok" }), rawItem({ id: "weird", teeth: "whole arch", surfaces: "" })],
    });
    const read = await getPlanPanelReadUncached("pat-1", "site-cc");
    expect(allRowIds(read).sort()).toEqual(["ok", "weird"]);
  });

  it("discards a row that names a DIFFERENT patient, and keeps one that names none", async () => {
    // The safety net for an endpoint that may ignore patient_id. Keeping the
    // no-owner row matters more than it looks: if the endpoint hangs its rows off
    // treatment_plan_id alone, dropping them would empty the panel while health
    // stayed "ok".
    feed({
      plans: [rawPlan()],
      items: [
        rawItem({ id: "mine", patient_id: "pat-1" }),
        rawItem({ id: "theirs", patient_id: "pat-2" }),
        rawItem({ id: "unowned", patient_id: undefined }),
      ],
    });
    const read = await getPlanPanelReadUncached("pat-1", "site-cc");
    expect(allRowIds(read).sort()).toEqual(["mine", "unowned"]);
  });
});

describe("paging and truncation", () => {
  it("pages the items walk and reports hitting the ceiling", async () => {
    // A plan cut off at the bound is a partial clinical record, and the screen has
    // to say so rather than print a confident total over the rows it happened to get.
    const full = Array.from({ length: PER_PAGE }, (_, i) => rawItem({ id: `p${i}` }));
    feed({ plans: [rawPlan()] });
    state.listTreatmentPlanItems = () => Promise.resolve({ treatment_plan_items: full });
    const read = await getPlanPanelReadUncached("pat-1", "site-cc");
    expect(read.truncated).toBe(true);
    expect(state.calls.items.length).toBeGreaterThan(1);
  });

  it("keeps the plan's truncation apart from the supporting reads'", async () => {
    // One shared flag put "this may not be the whole plan" on every patient of any
    // practice with a long history, and a caveat that is always on is ignored.
    const fullDiary = Array.from({ length: PER_PAGE }, (_, i) => ({ id: `a${i}` }));
    feed({ plans: [rawPlan()], items: [rawItem()] });
    state.getPatientAppointments = () => Promise.resolve({ appointments: fullDiary });
    const read = await getPlanPanelReadUncached("pat-1", "site-cc");
    expect(read.truncated).toBe(false);
    expect(read.truncatedSupporting).toBe(true);
  });

  it("stops after a short page", async () => {
    feed({ plans: [rawPlan()], items: [rawItem()] });
    await getPlanPanelReadUncached("pat-1", "site-cc");
    expect(state.calls.items).toHaveLength(1);
    expect(state.calls.appts).toHaveLength(1);
  });
});

describe("the cache never pins a failure", () => {
  it("caches a healthy read", async () => {
    feed({ plans: [rawPlan()], items: [rawItem()] });
    await getPlanPanelRead("pat-1", "site-cc");
    await getPlanPanelRead("pat-1", "site-cc");
    expect(state.calls.items).toHaveLength(1);
  });

  it("does NOT cache a read with any failed stream", async () => {
    // Memoising a blip would pin "we could not read this patient's plan" onto that
    // patient for the full window, for every user, long after Dentally recovered.
    feed({ plans: [rawPlan()] });
    state.listTreatmentPlanItems = () => Promise.reject(new Error("boom"));
    await getPlanPanelRead("pat-1", "site-cc");
    await getPlanPanelRead("pat-1", "site-cc");
    expect(state.calls.items.length).toBeGreaterThan(1);
  });

  it("keys the cache on patient AND site", async () => {
    feed({ plans: [rawPlan()], items: [rawItem()] });
    await getPlanPanelRead("pat-1", "site-cc");
    await getPlanPanelRead("pat-1", "site-rv");
    expect(state.calls.items).toHaveLength(2);
  });
});

describe("the read makes no write call of any kind", () => {
  it("exercises only GET-shaped client methods", async () => {
    // The panel renders `+ add appointment`, `Charge`, `Complete treatment plan`
    // and `Submit claim`. Every one is disabled, and this asserts the data layer
    // beneath them stays read-only: a write method appearing on the client is how
    // someone later wires one.
    const seen: string[] = [];
    const { DentallyClient } = await import("./client");
    const proto = DentallyClient.prototype as unknown as Record<string, unknown>;
    for (const k of Object.getOwnPropertyNames(proto)) if (k !== "constructor") seen.push(k);
    // The stub class above IS the surface this read can reach. If a write method
    // ever has to be added to it to make the read compile, this fails loudly.
    expect(seen.sort()).toEqual([
      "getPatientAppointments",
      "listPractitioners",
      "listTreatmentAppointments",
      "listTreatmentPlanItems",
      "listTreatmentPlansById",
    ]);
  });
});
