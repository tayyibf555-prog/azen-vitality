// The chart read: shaping, per-stream health, paging bounds and the cache rule.
//
// Every assertion here is about the same thing said four ways: an incomplete read
// must never render as a complete chart. A dropped row, a swallowed surface letter,
// a caught exception that returns [] with health still "ok", or a failure pinned
// into a shared cache all produce the same lie on screen — thirty-two clean teeth
// that claim this patient has no findings.
import { describe, it, expect, vi, beforeEach } from "vitest";

const PER_PAGE = 100;

interface ClientStubs {
  listTreatmentPlanItems: (a: { page?: number }) => Promise<unknown>;
  listTreatments: (a: { page?: number }) => Promise<unknown>;
  listTreatmentCategories: (a: { page?: number }) => Promise<unknown>;
  listTreatmentPlansById: (a: { page?: number }) => Promise<unknown>;
}

const state = vi.hoisted<ClientStubs>(() => ({
  listTreatmentPlanItems: () => Promise.resolve({ treatment_plan_items: [] }),
  listTreatments: () => Promise.resolve({ treatments: [] }),
  listTreatmentCategories: () => Promise.resolve({ treatment_categories: [] }),
  listTreatmentPlansById: () => Promise.resolve({ treatment_plans: [] }),
}));

vi.mock("./client", () => ({
  DentallyClient: class {
    constructor() {}
    listTreatmentPlanItems(a: { page?: number }) { return state.listTreatmentPlanItems(a); }
    listTreatments(a: { page?: number }) { return state.listTreatments(a); }
    listTreatmentCategories(a: { page?: number }) { return state.listTreatmentCategories(a); }
    listTreatmentPlansById(a: { page?: number }) { return state.listTreatmentPlansById(a); }
  },
}));

import { getPatientChart, getPatientChartUncached, clearChartReadCache } from "./charting-read";
import { surfaceIndicesOf } from "@/lib/charting/surfaces";

beforeEach(() => {
  vi.stubEnv("DENTALLY_API_KEY", "k");
  clearChartReadCache();
  state.listTreatmentPlanItems = () => Promise.resolve({ treatment_plan_items: [] });
  state.listTreatments = () => Promise.resolve({ treatments: [] });
  state.listTreatmentCategories = () => Promise.resolve({ treatment_categories: [] });
  state.listTreatmentPlansById = () => Promise.resolve({ treatment_plans: [] });
});

/** One raw treatment_plan_item, with everything defaulted so a case shows only
 *  what it is actually about. */
function rawItem(o: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "tpi-1", patient_id: "pat-1", teeth: [16], surfaces: "MOD",
    completed: false, base_chart: false, charged: false, price: 100, value: 100,
    duration: 20, position: 1, created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-02T00:00:00Z", ...o,
  };
}

function items(rows: Record<string, unknown>[]) {
  state.listTreatmentPlanItems = () => Promise.resolve({ treatment_plan_items: rows });
}

describe("getPatientChartUncached shaping", () => {
  it("maps ids that arrive as NUMBERS, not just as mock strings", async () => {
    // Real Dentally sends numeric ids and the local mock sends strings. Using the
    // string coercer alone returns null for a number, which once sent every live
    // appointment into the diary's Unassigned column.
    items([
      rawItem({ id: 4242, patient_id: 77, treatment_plan_id: 91, treatment_id: 12, practitioner_id: 5 }),
    ]);
    const chart = await getPatientChartUncached("77", "site-cc");
    expect(chart.items).toHaveLength(1);
    expect(chart.items[0].id).toBe("4242");
    expect(chart.items[0].planId).toBe("91");
    expect(chart.items[0].treatmentId).toBe("12");
    expect(chart.items[0].practitionerId).toBe("5");
  });

  it("routes a row whose teeth will not parse into unplaced, keeping the raw value", async () => {
    // Dropping the row would be indistinguishable from the practice never having
    // recorded the finding, so it keeps its raw value and is counted on screen.
    items([
      rawItem({ id: "a", teeth: [16] }),
      rawItem({ id: "b", teeth: "whole mouth", surfaces: "" }),
    ]);
    const chart = await getPatientChartUncached("pat-1", "site-cc");
    expect(chart.items.map((i) => i.id)).toEqual(["a"]);
    expect(chart.unplaced).toHaveLength(1);
    expect(chart.unplaced[0].rawTeeth).toBe("whole mouth");
  });

  // DENTALLY.md, verified against the API: "All teeth are stored using Palmer
  // notation." This was the shape parseTeeth refused, so on live data EVERY row
  // would have gone to unplaced and the arch would have drawn 32 clean teeth.
  it("places the Palmer notation Dentally actually stores, rather than filing it as unreadable", async () => {
    items([rawItem({ id: "p", teeth: "UR6", surfaces: "MO" })]);
    const chart = await getPatientChartUncached("pat-1", "site-cc");
    expect(chart.unplaced).toHaveLength(0);
    expect(chart.items[0].teeth).toEqual([16]);
  });

  // An examination, a radiograph, a hygiene appointment and a denture all name
  // no tooth, and on a real chart they are most of the rows. Filing them as
  // "could not place" printed a large unplaced count on every patient.
  it("keeps a treatment that names NO tooth in items, rather than reporting it as unreadable", async () => {
    items([rawItem({ id: "exam", teeth: [], surfaces: "", nomenclature: "Examination" })]);
    const chart = await getPatientChartUncached("pat-1", "site-cc");
    expect(chart.unplaced).toHaveLength(0);
    expect(chart.items.map((i) => i.id)).toEqual(["exam"]);
  });

  // Surfaces arrive as INTEGERS. A number left surfaces and unrecognised both
  // empty, and the row was then computed as whole-tooth: a single-surface
  // filling drew the crown ring that means extraction.
  //
  // AN IN-SCHEME INDEX IS NOW PLACED, NOT REPORTED. Tooth 16 is a molar and 3 is
  // the bottom trapezoid on every tooth, so the row carries a surface we CAN
  // draw. Asserting it into unrecognisedSurfaces would pin the old behaviour, in
  // which every live restoration drew a "could not place" ring instead of a fill.
  it("does not turn a numeric surface into a whole-tooth finding", async () => {
    items([rawItem({ teeth: [16], surfaces: 3 })]);
    const chart = await getPatientChartUncached("pat-1", "site-cc");
    expect(chart.items[0].wholeTooth).toBe(false);
    expect(chart.items[0].unrecognisedSurfaces).toEqual([]);
    expect(surfaceIndicesOf(chart.items[0])).toEqual([3]);
  });

  // The other half of the same rule: an index with no region on ANY tooth the row
  // names is never nudged onto the nearest one. An incisor has five regions, so a
  // 7 on it stays visible in the tooltip, in History, in the export and in the
  // status-bar count rather than being drawn somewhere plausible.
  it("keeps an index outside the tooth's own scheme visible rather than clamping it", async () => {
    items([rawItem({ teeth: [11], surfaces: [1, 7] })]);
    const chart = await getPatientChartUncached("pat-1", "site-cc");
    expect(surfaceIndicesOf(chart.items[0])).toEqual([1]);
    expect(chart.items[0].unrecognisedSurfaces).toEqual(["7"]);
    expect(chart.items[0].wholeTooth).toBe(false);
  });

  // If this endpoint hangs its rows off treatment_plan_id alone, the old
  // predicate discarded every one of them, health stayed "ok", and the screen
  // printed "No treatment items on this patient's chart in Dentally" for a
  // patient with a full chart.
  it("keeps a row that carries no patient_id, and still discards another patient's", async () => {
    items([
      { ...rawItem({ id: "mine" }), patient_id: undefined },
      { ...rawItem({ id: "theirs" }), patient_id: "pat-2" },
    ]);
    const chart = await getPatientChartUncached("pat-1", "site-cc");
    expect(chart.items.map((i) => i.id)).toEqual(["mine"]);
  });

  it("sets wholeTooth for a row with teeth and no surfaces (an extraction)", async () => {
    // Without this flag a per-surface renderer draws a planned extraction as a
    // clean, unmarked tooth: the most direct route this screen has to a wrong site.
    items([rawItem({ teeth: [26], surfaces: "", nomenclature: "Extraction - Simple" })]);
    const chart = await getPatientChartUncached("pat-1", "site-cc");
    expect(chart.items[0].wholeTooth).toBe(true);
  });

  it("does NOT set wholeTooth for surface work", async () => {
    items([rawItem({ teeth: [16], surfaces: "MOD" })]);
    const chart = await getPatientChartUncached("pat-1", "site-cc");
    expect(chart.items[0].wholeTooth).toBe(false);
  });

  it("keeps an unrecognised surface letter rather than swallowing it", async () => {
    items([rawItem({ surfaces: "MODX" })]);
    const chart = await getPatientChartUncached("pat-1", "site-cc");
    expect(chart.items[0].surfaces).toHaveLength(3);
    expect(chart.items[0].unrecognisedSurfaces).toContain("X");
    expect(chart.items[0].rawSurfaces).toBe("MODX");
  });

  it("prints the staff nomenclature and never the patient-facing twin", async () => {
    items([rawItem({ nomenclature: "Extraction - Surgical", patient_nomenclature: "Tooth removal" })]);
    const chart = await getPatientChartUncached("pat-1", "site-cc");
    expect(chart.items[0].nomenclature).toBe("Extraction - Surgical");
  });

  it("filters out a row belonging to another patient even when the API returns it", async () => {
    // Whether this endpoint honours patient_id is unverified. A chart showing
    // another patient's items is the worst outcome available on this screen.
    items([rawItem({ id: "mine", patient_id: "pat-1" }), rawItem({ id: "theirs", patient_id: "pat-9" })]);
    const chart = await getPatientChartUncached("pat-1", "site-cc");
    expect(chart.items.map((i) => i.id)).toEqual(["mine"]);
  });

  it("populates fetchedAt, so the screen can state its own age", async () => {
    const chart = await getPatientChartUncached("pat-1", "site-cc");
    expect(Number.isNaN(Date.parse(chart.fetchedAt))).toBe(false);
  });

  it("reads the funding plan id from the flat field and the nested object alike", async () => {
    items([
      rawItem({ id: "flat", payment_plan_id: 1 }),
      rawItem({ id: "nested", payment_plan: { id: 2 } }),
    ]);
    const chart = await getPatientChartUncached("pat-1", "site-cc");
    expect(chart.items.find((i) => i.id === "flat")?.paymentPlanId).toBe(1);
    expect(chart.items.find((i) => i.id === "nested")?.paymentPlanId).toBe(2);
  });
});

describe("plan rows", () => {
  function plans(rows: Record<string, unknown>[]) {
    state.listTreatmentPlansById = () => Promise.resolve({ treatment_plans: rows });
  }

  it("calls a plan with no start_date and no accepted_at UNACCEPTED", async () => {
    // The reason this status exists: an item on a plan the patient declined must
    // not render identically to one on the live accepted plan. Note the deliberate
    // departure from read.ts's PlanRecord, which falls back to created_at — every
    // plan has one, so that fallback would make every plan read "accepted".
    plans([{ id: 1, patient_id: "pat-1", nickname: "Crown UL4", created_at: "2026-05-01T00:00:00Z" }]);
    const chart = await getPatientChartUncached("pat-1", "site-cc");
    expect(chart.plans[0].status).toBe("unaccepted");
    expect(chart.plans[0].acceptedAt).toBeNull();
    expect(chart.plans[0].id).toBe("1");
  });

  it("calls a plan with a start_date accepted, and a completed one completed", async () => {
    plans([
      { id: 2, patient_id: "pat-1", start_date: "2026-04-01T00:00:00Z" },
      { id: 3, patient_id: "pat-1", start_date: "2026-01-01T00:00:00Z", completed_at: "2026-03-01T00:00:00Z" },
    ]);
    const chart = await getPatientChartUncached("pat-1", "site-cc");
    expect(chart.plans.map((p) => p.status)).toEqual(["accepted", "completed"]);
  });

  it("drops another patient's plan, matching numeric ids to string ones", async () => {
    plans([{ id: 4, patient_id: 1, start_date: "2026-04-01T00:00:00Z" }]);
    const chart = await getPatientChartUncached("1", "site-cc");
    expect(chart.plans).toHaveLength(1);
  });
});

describe("per-stream health", () => {
  it("flags a failed ITEMS read while treatments still succeed", async () => {
    // The clinically important case: the chart stream alone failing. It must not be
    // masked by the other three working, and it must not render as an empty chart.
    state.listTreatmentPlanItems = () => Promise.reject(new Error("502"));
    state.listTreatments = () => Promise.resolve({ treatments: [{ id: 1, name: "Composite Filling" }] });
    const chart = await getPatientChartUncached("pat-1", "site-cc");
    expect(chart.health.items).toBe("failed");
    expect(chart.health.treatments).toBe("ok");
    expect(chart.items).toEqual([]);
    expect(chart.treatments).toHaveLength(1);
  });

  it("flags a failed PLANS read independently of the items read", async () => {
    // "We could not read the plans" and "this patient has no treatment plans" are
    // different clinical statements, which is why plans is its own fourth key.
    state.listTreatmentPlansById = () => Promise.reject(new Error("boom"));
    items([rawItem({})]);
    const chart = await getPatientChartUncached("pat-1", "site-cc");
    expect(chart.health.plans).toBe("failed");
    expect(chart.health.items).toBe("ok");
    expect(chart.items).toHaveLength(1);
    expect(chart.plans).toEqual([]);
  });

  it("flags categories on their own too", async () => {
    state.listTreatmentCategories = () => Promise.reject(new Error("boom"));
    const chart = await getPatientChartUncached("pat-1", "site-cc");
    expect(chart.health).toEqual({ items: "ok", treatments: "ok", categories: "failed", plans: "ok" });
  });
});

describe("paging", () => {
  /** Returns PER_PAGE rows per page forever, so the walk can only end at its ceiling. */
  function endlessItems(): number[] {
    const pagesSeen: number[] = [];
    state.listTreatmentPlanItems = (a) => {
      const page = a.page ?? 1;
      pagesSeen.push(page);
      const rows = Array.from({ length: PER_PAGE }, (_, i) =>
        rawItem({ id: `p${page}-${i}`, teeth: [16] }),
      );
      return Promise.resolve({ treatment_plan_items: rows });
    };
    return pagesSeen;
  }

  it("stops on a short page and does NOT claim truncation", async () => {
    items([rawItem({}), rawItem({ id: "two" })]);
    const chart = await getPatientChartUncached("pat-1", "site-cc");
    expect(chart.truncated).toBe(false);
    expect(chart.items).toHaveLength(2);
  });

  it("walks past the first page rather than truncating at 100 silently", async () => {
    const pagesSeen: number[] = [];
    state.listTreatmentPlanItems = (a) => {
      const page = a.page ?? 1;
      pagesSeen.push(page);
      const count = page === 1 ? PER_PAGE : 7;
      const rows = Array.from({ length: count }, (_, i) => rawItem({ id: `p${page}-${i}` }));
      return Promise.resolve({ treatment_plan_items: rows });
    };
    const chart = await getPatientChartUncached("pat-1", "site-cc");
    expect(pagesSeen).toEqual([1, 2]);
    expect(chart.items).toHaveLength(107);
    expect(chart.truncated).toBe(false);
  });

  it("sets truncated when the ceiling is reached, so a partial chart says so", async () => {
    // This is what would expose a source that IGNORES patient_id: the walk never
    // runs out of rows and the ceiling caps an arbitrary slice, which without this
    // flag would be rendered as the whole chart.
    const pagesSeen = endlessItems();
    const chart = await getPatientChartUncached("pat-1", "site-cc");
    expect(chart.truncated).toBe(true);
    expect(pagesSeen).toHaveLength(25);
  });

  // ONE FLAG FOR FOUR WALKS was the defect. The catalogue walk is bounded at 5
  // pages, so a practice whose stock treatment list runs past 500 rows raised
  // `truncated` on every patient forever, and CHART_COPY.truncated reads "may
  // not be the whole of this patient's chart". A caveat that is always on is a
  // caveat nobody reads, and this one was about the LIST, not the person.
  it("keeps a truncated treatment catalogue apart from a truncated chart", async () => {
    items([rawItem({})]);
    state.listTreatments = () =>
      Promise.resolve({
        treatments: Array.from({ length: PER_PAGE }, (_, i) => ({ id: `t${i}`, name: "T" })),
      });
    const chart = await getPatientChartUncached("pat-1", "site-cc");
    expect(chart.truncatedCatalogue).toBe(true);
    expect(chart.truncated).toBe(false);
  });
});

describe("the cache", () => {
  it("serves a second read of the same patient from cache", async () => {
    let calls = 0;
    state.listTreatmentPlanItems = () => {
      calls += 1;
      return Promise.resolve({ treatment_plan_items: [rawItem({})] });
    };
    await getPatientChart("pat-1", "site-cc");
    await getPatientChart("pat-1", "site-cc");
    expect(calls).toBe(1);
  });

  it("does NOT cache a read with a failed stream", async () => {
    // read.ts's cachedRead memoises whatever resolves. Using it here would pin
    // "we could not read this patient's chart" onto that patient for a full thirty
    // seconds, for every user on the instance, after Dentally had already recovered.
    let calls = 0;
    state.listTreatmentPlanItems = () => {
      calls += 1;
      return Promise.reject(new Error("502"));
    };
    const first = await getPatientChart("pat-1", "site-cc");
    expect(first.health.items).toBe("failed");
    await getPatientChart("pat-1", "site-cc");
    expect(calls).toBe(2); // re-read, not a pinned failure
  });

  it("keys the cache per patient AND per site", async () => {
    let calls = 0;
    state.listTreatmentPlanItems = () => {
      calls += 1;
      return Promise.resolve({ treatment_plan_items: [] });
    };
    await getPatientChart("pat-1", "site-cc");
    await getPatientChart("pat-2", "site-cc");
    await getPatientChart("pat-1", "site-rv");
    expect(calls).toBe(3);
  });
});
