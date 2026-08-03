import { describe, it, expect } from "vitest";
import { groupByPlan, historyLines, surfaceIndexText, toothHistory } from "./history";
import type { ChartItem, PlanRow } from "./types";

function item(over: Partial<ChartItem> = {}): ChartItem {
  return {
    id: "i1",
    teeth: [16],
    rawTeeth: "16",
    surfaces: ["mesial", "occlusal"],
    rawSurfaces: "MO",
    surfaceIndices: [],
    unrecognisedSurfaces: [],
    wholeTooth: false,
    region: null,
    baseChart: false,
    completed: false,
    completedAt: null,
    charged: false,
    notes: null,
    nomenclature: "Filling",
    price: 25.8,
    value: 25.8,
    durationMin: 20,
    nhsTreatmentCat: null,
    udaBand: null,
    position: 0,
    planId: null,
    treatmentId: null,
    practitionerId: null,
    paymentPlanId: 1,
    createdAt: "2026-01-01T09:00:00Z",
    updatedAt: null,
    ...over,
  };
}

const PLANS: PlanRow[] = [
  { id: "p1", label: "Plan 1", status: "accepted", acceptedAt: "2026-01-01T00:00:00Z" },
  { id: "p2", label: "Plan 2", status: "unaccepted", acceptedAt: null },
];

describe("toothHistory", () => {
  // A bridge is not the property of one abutment. Attributing it to the first
  // tooth only hides it from the tooth the clinician happens to hover.
  it("shows an item on two teeth in BOTH teeth's histories", () => {
    const bridge = item({ id: "b", teeth: [16, 14], rawTeeth: "16,14", wholeTooth: true, surfaces: [] });
    expect(toothHistory([bridge], 16).map((l) => l.itemId)).toEqual(["b"]);
    expect(toothHistory([bridge], 14).map((l) => l.itemId)).toEqual(["b"]);
    expect(toothHistory([bridge], 15)).toEqual([]);
  });

  it("puts the newest first, by completion date, then update, then creation", () => {
    const older = item({ id: "old", createdAt: "2025-06-01T09:00:00Z" });
    const newer = item({ id: "new", createdAt: "2026-02-01T09:00:00Z" });
    const completed = item({
      id: "done",
      completed: true,
      completedAt: "2026-03-01T09:00:00Z",
      createdAt: "2020-01-01T09:00:00Z",
    });
    expect(toothHistory([older, newer, completed], 16).map((l) => l.itemId)).toEqual([
      "done",
      "new",
      "old",
    ]);
  });

  // Sorting an unreadable date to the epoch buries a real finding at the
  // bottom AND makes it look ancient. Dropping it is worse still.
  it("keeps an item whose date will not parse, and sorts it last rather than to the epoch", () => {
    const undated = item({ id: "nodate", createdAt: "not a date", updatedAt: null });
    const dated = item({ id: "dated", createdAt: "2020-01-01T09:00:00Z" });
    const lines = toothHistory([undated, dated], 16);
    expect(lines.map((l) => l.itemId)).toEqual(["dated", "nodate"]);
    expect(lines).toHaveLength(2);
  });

  it("carries the tooth's name, its two-digit FDI number and the surfaces code", () => {
    const [line] = toothHistory([item()], 16);
    expect(line.toothLabel).toBe("UR6");
    expect(line.fdi).toBe(16);
    expect(line.surfaces).toBe("MO");
    expect(line.price).toBe(25.8);
  });

  it("keeps unrecognised surface letters on the line rather than swallowing them", () => {
    const odd = item({ unrecognisedSurfaces: ["X"], rawSurfaces: "MOX" });
    expect(toothHistory([odd], 16)[0].unrecognisedSurfaces).toEqual(["X"]);
  });

  it("names the plan and states whether the patient accepted it", () => {
    const live = toothHistory([item({ planId: "p1" })], 16, PLANS)[0];
    expect(live.planLabel).toBe("Plan 1");
    expect(live.planStatus).toBe("accepted");
    const cold = toothHistory([item({ planId: "p2" })], 16, PLANS)[0];
    expect(cold.planStatus).toBe("unaccepted");
    // A plan we could not read must not be reported as accepted.
    const unknown = toothHistory([item({ planId: "p-missing" })], 16, PLANS)[0];
    expect(unknown.planStatus).toBeNull();
  });
});

describe("historyLines", () => {
  it("makes one line per item, naming every tooth it concerns", () => {
    const bridge = item({ id: "b", teeth: [16, 14], rawTeeth: "16,14" });
    const [line] = historyLines([bridge], {});
    expect(line.toothLabel).toBe("UR6, UR4");
    expect(line.fdi).toBeNull();
  });

  it("filters by plan, by completion and by free text together", () => {
    const rows = [
      item({ id: "a", planId: "p1", completed: true, completedAt: "2026-02-01T09:00:00Z" }),
      item({ id: "b", planId: "p2", nomenclature: "Extraction" }),
      item({ id: "c", planId: "p1", nomenclature: "Crown" }),
    ];
    expect(historyLines(rows, { planId: "p1" }).map((l) => l.itemId).sort()).toEqual(["a", "c"]);
    expect(historyLines(rows, { completedOnly: true }).map((l) => l.itemId)).toEqual(["a"]);
    expect(historyLines(rows, { query: "extract" }).map((l) => l.itemId)).toEqual(["b"]);
    expect(historyLines(rows, { query: "UR6" }).map((l) => l.itemId).sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  // An unplaced item is the one the parser could not draw. Excluding it by
  // default would make History agree with the arch about a finding neither of
  // them is showing.
  it("includes an unplaced item by default and shows the raw value Dentally sent", () => {
    const unplaced = item({ id: "u", teeth: [], rawTeeth: "whole mouth" });
    const [line] = historyLines([unplaced], {});
    expect(line.rawTeeth).toBe("whole mouth");
    expect(line.toothLabel).toBe("");
    expect(historyLines([unplaced], { includeUnplaced: false })).toEqual([]);
  });
});

describe("groupByPlan", () => {
  it("keeps items with no plan in their own group rather than merging them into the first plan", () => {
    const rows = [item({ id: "a", planId: "p1" }), item({ id: "b", planId: null })];
    const groups = groupByPlan(rows, PLANS);
    const unattached = groups.find((g) => g.planId === null);
    expect(unattached?.lines.map((l) => l.itemId)).toEqual(["b"]);
    expect(unattached?.label.toLowerCase()).toContain("not attached");
    expect(groups.find((g) => g.planId === "p1")?.lines.map((l) => l.itemId)).toEqual(["a"]);
  });

  it("labels an unaccepted plan as unaccepted, so a declined plan is never read as live", () => {
    const groups = groupByPlan([item({ id: "c", planId: "p2" })], PLANS);
    const g = groups.find((x) => x.planId === "p2");
    expect(g?.status).toBe("unaccepted");
    expect(g?.label).toBe("Plan 2");
  });

  it("keeps a group for a plan id we could not read, rather than dropping its items", () => {
    const groups = groupByPlan([item({ id: "d", planId: "p-missing" })], PLANS);
    const g = groups.find((x) => x.planId === "p-missing");
    expect(g?.lines).toHaveLength(1);
    expect(g?.status).toBeNull();
  });

  it("returns no empty groups for plans with no items on this chart", () => {
    expect(groupByPlan([], PLANS)).toEqual([]);
  });
});

/**
 * A live row carries NO letter code, only Dentally's integer surface numbers. The
 * tooltip, the History table and the CSV all read `surfaces`, so on a real patient
 * the "where on the tooth" column was blank on every row of a clinical history —
 * a narrower record than the practice actually holds, presented as the whole one.
 */
describe("history and Dentally's surface indices", () => {
  const live = (indices: number[]) => ({
    ...item({ surfaces: [], rawSurfaces: indices.join(",") }),
    surfaceIndices: indices,
  });

  it("carries the indices onto the line, and phrases them without naming an anatomy", () => {
    const [line] = toothHistory([live([3, 8])], 16, PLANS);
    expect(line.surfaceIndices).toEqual([3, 8]);
    expect(line.surfaceIndexText).toBe("surfaces 3, 8");
    expect(surfaceIndexText([5])).toBe("surface 5");
    expect(surfaceIndexText([])).toBe("");
    // The index is printed VERBATIM. Translating it would be a wrong-surface
    // clinical claim: which surface a number is depends on how Dentally orients
    // the quadrant, and nothing public says.
    expect(line.surfaceIndexText).not.toMatch(/mesial|distal|buccal|lingual|occlusal/i);
    // It is NOT smuggled into the letter code, which is a different vocabulary.
    expect(line.surfaces).toBe("");
    // And it is not an unreadable value either: we placed it on the arch.
    expect(line.unrecognisedSurfaces).toEqual([]);
    expect(line.wholeTooth).toBe(false);
  });

  it("finds a row by the surface number a clinician reads off Dentally", () => {
    const lines = historyLines([live([7]), item()], { query: "surface 7", plans: PLANS });
    expect(lines).toHaveLength(1);
    expect(lines[0].surfaceIndices).toEqual([7]);
  });
});
