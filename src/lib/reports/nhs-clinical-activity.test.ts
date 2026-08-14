import { describe, it, expect } from "vitest";
import type { DayWindow } from "@/lib/dashboard/period";
import {
  normaliseClinicalItem,
  clinicalWindowDay,
  computeNhsClinicalReport,
  type NhsClinicalReport,
} from "@/lib/reports/nhs-clinical-activity";

// A raw treatment_plan_item, live-shaped: ints for ids/band, ISO for timestamps.
function raw(o: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: 1,
    practitioner_id: 100,
    uda_band: 1,
    completed: true,
    completed_at: "2026-08-05T10:00:00Z",
    created_at: "2026-07-20T09:00:00Z",
    treatment_plan_id: 900,
    patient_id: 500,
    ...o,
  };
}

const WINDOW: DayWindow = { from: "2026-08-01", to: "2026-08-14" };

describe("normaliseClinicalItem", () => {
  it("reads live int ids and an int band, mapping 0-4 through canonicalBand", () => {
    expect(normaliseClinicalItem(raw({ uda_band: 1 }))?.band).toBe("band1");
    expect(normaliseClinicalItem(raw({ uda_band: 2 }))?.band).toBe("band2");
    expect(normaliseClinicalItem(raw({ uda_band: 3 }))?.band).toBe("band3");
    expect(normaliseClinicalItem(raw({ uda_band: 4 }))?.band).toBe("urgent");
    expect(normaliseClinicalItem(raw({ uda_band: 0 }))?.band).toBe("other");
  });

  it("treats a MISSING uda_band as non-NHS (band null), but 0 as a real band", () => {
    expect(normaliseClinicalItem(raw({ uda_band: null }))?.band).toBeNull();
    expect(normaliseClinicalItem(raw({ uda_band: undefined }))?.band).toBeNull();
    // 0 must NOT collapse to null — it is "other", a real banded value.
    const zero = normaliseClinicalItem(raw({ uda_band: 0 }));
    expect(zero?.band).toBe("other");
    expect(zero?.rawBand).toBe("0");
  });

  it("accepts string bands too (mock / charting fixtures)", () => {
    expect(normaliseClinicalItem(raw({ uda_band: "Band 2" }))?.band).toBe("band2");
    expect(normaliseClinicalItem(raw({ uda_band: "  " }))?.band).toBeNull();
  });

  it("keeps an unrecognised but PRESENT band as unknown, not as non-NHS", () => {
    const it = normaliseClinicalItem(raw({ uda_band: 9 }));
    expect(it?.band).toBe("unknown");
    expect(it?.rawBand).toBe("9");
  });

  it("coerces int ids to strings and drops a row with no id", () => {
    const it = normaliseClinicalItem(raw({ id: 42, practitioner_id: 7, patient_id: 8, treatment_plan_id: 9 }));
    expect(it).toMatchObject({ id: "42", practitionerId: "7", patientId: "8", planId: "9" });
    expect(normaliseClinicalItem(raw({ id: null }))).toBeNull();
    expect(normaliseClinicalItem(raw({ id: "" }))).toBeNull();
    expect(normaliseClinicalItem("nonsense")).toBeNull();
  });

  it("resolves the London day of both date fields", () => {
    const it = normaliseClinicalItem(raw({ completed_at: "2026-08-05T23:30:00Z", created_at: "2026-07-20" }));
    expect(it?.completedDay).toBe("2026-08-06"); // 23:30 UTC = 00:30 BST next day
    expect(it?.plannedDay).toBe("2026-07-20");
  });
});

describe("clinicalWindowDay — the completed/pending asymmetry, isolated", () => {
  it("places a completed item by completed_at", () => {
    const it = normaliseClinicalItem(raw({ completed: true, completed_at: "2026-08-05T10:00:00Z", created_at: "2026-01-01" }))!;
    expect(clinicalWindowDay(it)).toBe("2026-08-05");
  });

  it("places a PENDING item by created_at (it has no completion date)", () => {
    const it = normaliseClinicalItem(raw({ completed: false, completed_at: null, created_at: "2026-08-06T09:00:00Z" }))!;
    expect(clinicalWindowDay(it)).toBe("2026-08-06");
  });

  it("returns null for a completed item with no completed_at — never falls back to created_at", () => {
    const it = normaliseClinicalItem(raw({ completed: true, completed_at: null, created_at: "2026-08-05" }))!;
    expect(clinicalWindowDay(it)).toBeNull();
  });
});

describe("computeNhsClinicalReport — grouping, three units, and NO COUNT VANISHES", () => {
  // 11 raw rows spanning every bucket. Hand-computed so the exact figures pin the
  // aggregator: a mutation that mis-buckets a single row changes one of these.
  const items: unknown[] = [
    // 1: prac A, band1, COMPLETED in window, plan P1, pat1
    raw({ id: 1, practitioner_id: "A", uda_band: 1, completed: true, completed_at: "2026-08-05", created_at: "2026-07-20", treatment_plan_id: "P1", patient_id: "pat1" }),
    // 2: prac A, band1, PENDING in window (created), SAME plan P1, pat2
    raw({ id: 2, practitioner_id: "A", uda_band: 1, completed: false, completed_at: null, created_at: "2026-08-06", treatment_plan_id: "P1", patient_id: "pat2" }),
    // 3: prac A, band2, COMPLETED in window, SAME plan P1, SAME pat1
    raw({ id: 3, practitioner_id: "A", uda_band: 2, completed: true, completed_at: "2026-08-07", created_at: "2026-07-01", treatment_plan_id: "P1", patient_id: "pat1" }),
    // 4: prac B, band3, COMPLETED in window, plan P2, pat3
    raw({ id: 4, practitioner_id: "B", uda_band: 3, completed: true, completed_at: "2026-08-08", created_at: "2026-08-01", treatment_plan_id: "P2", patient_id: "pat3" }),
    // 5: prac A, other(0), COMPLETED in window, NO plan id, pat1
    raw({ id: 5, practitioner_id: "A", uda_band: 0, completed: true, completed_at: "2026-08-09", created_at: "2026-08-02", treatment_plan_id: null, patient_id: "pat1" }),
    // 6: prac A, NON-NHS (no band) -> excludedNonNhs
    raw({ id: 6, practitioner_id: "A", uda_band: null, completed: true, completed_at: "2026-08-09" }),
    // 7: prac B, band1, COMPLETED OUTSIDE window though CREATED inside -> excludedOutOfWindow (proves no created_at fallback)
    raw({ id: 7, practitioner_id: "B", uda_band: 1, completed: true, completed_at: "2026-07-15", created_at: "2026-08-03", treatment_plan_id: "P9", patient_id: "patX" }),
    // 8: prac B, band2, PENDING created OUTSIDE window -> excludedOutOfWindow
    raw({ id: 8, practitioner_id: "B", uda_band: 2, completed: false, completed_at: null, created_at: "2026-07-20", treatment_plan_id: "P8", patient_id: "patY" }),
    // 9: prac A, band2, COMPLETED but NO completed_at -> droppedUnreadable (unplaceable)
    raw({ id: 9, practitioner_id: "A", uda_band: 2, completed: true, completed_at: null, created_at: "2026-08-05", treatment_plan_id: "P1", patient_id: "pat1" }),
    // 10: no id -> droppedUnreadable
    raw({ id: null }),
    // 11: DUPLICATE of id 1 -> droppedUnreadable
    raw({ id: 1, practitioner_id: "A", uda_band: 1, completed: true, completed_at: "2026-08-05", created_at: "2026-07-20", treatment_plan_id: "P1", patient_id: "pat1" }),
  ];

  const report = computeNhsClinicalReport({ items, window: WINDOW });

  it("balances: item buckets add back to totalItemsScanned", () => {
    expect(report.totalItemsScanned).toBe(11);
    expect(report.excludedNonNhs).toBe(1);
    expect(report.excludedOutOfWindow).toBe(2);
    expect(report.droppedUnreadable).toBe(3);
    const g = report.grandTotal;
    expect(g.completed.items).toBe(4); // items 1,3,4,5
    expect(g.pending.items).toBe(1); // item 2
    // The invariant, stated arithmetically so a mis-bucket breaks it here too.
    expect(
      g.completed.items +
        g.pending.items +
        report.excludedNonNhs +
        report.excludedOutOfWindow +
        report.droppedUnreadable,
    ).toBe(report.totalItemsScanned);
    expect(report.balanced).toBe(true);
  });

  it("windows a completed item on completed_at, a pending item on created_at", () => {
    // item 7 (completed 2026-07-15, created 2026-08-03) is OUT; if it fell back to
    // created_at it would be in. item 8 (pending, created 2026-07-20) is OUT.
    // Neither reaches band3/band2 completed for prac B beyond item 4.
    const b = report.practitioners.find((p) => p.practitionerId === "B")!;
    expect(b.total.completed.items).toBe(1); // only item 4
    expect(b.total.pending.items).toBe(0);
  });

  it("reports items, distinct courses and distinct patients per cell", () => {
    const a = report.practitioners.find((p) => p.practitionerId === "A")!;
    const band1 = a.bands.find((c) => c.band === "band1")!;
    expect(band1.completed).toMatchObject({ items: 1, courses: 1, patients: 1, itemsWithoutPlanId: 0 });
    expect(band1.pending).toMatchObject({ items: 1, courses: 1, patients: 1, itemsWithoutPlanId: 0 });
    const other = a.bands.find((c) => c.band === "other")!;
    // item 5 has no plan id: it counts as an item and a patient, but zero courses.
    expect(other.completed).toMatchObject({ items: 1, courses: 0, patients: 1, itemsWithoutPlanId: 1 });
  });

  it("does NOT sum courses across bands — a plan spanning two bands counts once", () => {
    const a = report.practitioners.find((p) => p.practitionerId === "A")!;
    // band1 completed (item1, P1) + band2 completed (item3, P1) each show 1 course,
    // but the per-clinician completed total is the DISTINCT plan {P1} = 1, not 2.
    expect(a.bands.find((c) => c.band === "band1")!.completed.courses).toBe(1);
    expect(a.bands.find((c) => c.band === "band2")!.completed.courses).toBe(1);
    expect(a.total.completed.courses).toBe(1);
    // Patients likewise: item1 pat1, item3 pat1, item5 pat1 -> distinct {pat1} = 1.
    expect(a.total.completed.patients).toBe(1);
    // And items ARE summable: 3 completed items for A (1,3,5).
    expect(a.total.completed.items).toBe(3);
  });

  it("orders bands canonically and sorts clinicians by volume", () => {
    expect(report.bandsPresent).toEqual(["band1", "band2", "band3", "other"]);
    expect(report.practitioners.map((p) => p.practitionerId)).toEqual(["A", "B"]);
  });

  it("keeps a present-but-unknown band in the report, not in excludedNonNhs", () => {
    const withUnknown = computeNhsClinicalReport({
      items: [raw({ id: 50, uda_band: 9, completed: true, completed_at: "2026-08-05", treatment_plan_id: "Pu", patient_id: "pu" })],
      window: WINDOW,
    });
    expect(withUnknown.excludedNonNhs).toBe(0);
    expect(withUnknown.byBand.map((c) => c.band)).toEqual(["unknown"]);
    expect(withUnknown.balanced).toBe(true);
  });

  it("a report with no window still balances (no out-of-window drops)", () => {
    const noWindow: NhsClinicalReport = computeNhsClinicalReport({ items, window: null });
    expect(noWindow.excludedOutOfWindow).toBe(0);
    // items 7 and 8 now count; only id/dup/unplaceable drop, and non-NHS excludes.
    expect(
      noWindow.grandTotal.completed.items +
        noWindow.grandTotal.pending.items +
        noWindow.excludedNonNhs +
        noWindow.excludedOutOfWindow +
        noWindow.droppedUnreadable,
    ).toBe(noWindow.totalItemsScanned);
    expect(noWindow.balanced).toBe(true);
  });
});
