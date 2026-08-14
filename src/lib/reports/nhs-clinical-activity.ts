// ---------------------------------------------------------------------------
// REPORT C — the clinical completed-vs-pending breakdown, per clinician × band.
//
// This is the OTHER half of Blerta's question, and a SIBLING of Report A, not a
// rewrite of it. Report A (nhs-activity.ts) reads /v1/nhs_claims — the claim
// LIFECYCLE — and a claim is only raised once a course closes, so it structurally
// cannot show work that is "still pending treatment". The clinical done-vs-not
// signal lives on /v1/treatment_plan_items as a plain `completed` boolean, and
// that is what this reads. BandKey / BAND_KEYS / BAND_LABELS / canonicalBand are
// reused VERBATIM from Report A so both reports speak the same band vocabulary.
//
// THREE THINGS THIS FILE IS BUILT AROUND, each a live-calibration fact:
//
//  1. BAND IS PER-ITEM, NOT PER-COURSE. Within one treatment plan, items carried
//     bands [0, null, 1, 4] at once. So counting items by band is not the same as
//     counting courses by band, and there is no honest single band for a course.
//     The report therefore reports ALL THREE units side by side — items, distinct
//     courses (distinct treatment_plan_id) and distinct patients — and never
//     synthesises a course-level band. Courses and patients are DISTINCT sets, so
//     they are NOT summable across bands; only items are.
//
//  2. THE WINDOWING ASYMMETRY. Completed items are windowed on completed_at;
//     PENDING items have no completion date, so they window on created_at (when
//     the work was planned / the patient was seen). This single load-bearing rule
//     is isolated in clinicalWindowDay() and nowhere else.
//
//  3. NO COUNT VANISHES. Every scanned item lands in exactly one place: a band
//     cell (completed or pending), excludedNonNhs (private / no band),
//     excludedOutOfWindow, or droppedUnreadable. Their item counts must add back
//     up to totalItemsScanned, or `balanced` is false and the caller renders the
//     report unavailable — the same discipline the allocation report uses for
//     money. This is the analogue of "no money vanishes".
//
// Pure functions only: no I/O, no clock reads. Callers pass the window.
// ---------------------------------------------------------------------------

import {
  canonicalBand,
  BAND_KEYS,
  type BandKey,
} from "@/lib/reports/nhs-activity";
import { isDayInWindow, isDayKey, londonDayOfIso, type DayWindow } from "@/lib/dashboard/period";

export { BAND_KEYS, BAND_LABELS, canonicalBand, type BandKey } from "@/lib/reports/nhs-activity";

// --- Normalising one raw /v1/treatment_plan_items row -----------------------

/**
 * A treatment plan item reduced to only what Report C needs.
 *
 * `band` is null ONLY when the raw item carries no uda_band at all — that is the
 * private / non-NHS case, and it is excluded from the NHS report. When a band IS
 * present, `band` is one of the six canonical keys (never null); an unrecognised
 * value becomes `unknown` and is reported, never dropped.
 */
export interface NormalisedClinicalItem {
  id: string;
  practitionerId: string | null;
  /** null == non-NHS (no uda_band). Otherwise a canonical band key. */
  band: BandKey | null;
  rawBand: string | null;
  completed: boolean;
  /** London day the item was marked completed, or null. */
  completedDay: string | null;
  /** London day the item was created (planned). The pending half windows on this. */
  plannedDay: string | null;
  /** Distinct treatment plan == a course of treatment. null == cannot group. */
  planId: string | null;
  patientId: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A string id from a string or a finite number (live sends these as ints). */
function asId(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Reduce uda_band to the string canonicalBand expects. Live sends bare INTS
 * (0,1,2,3,4) or null; the mock/charting fixtures send strings ("1","Band 2").
 * A number becomes its decimal string; a blank/absent value becomes null (the
 * non-NHS signal). `0` is a real band value ("other"), NOT absence — so it must
 * survive as "0", which is why this checks null/undefined explicitly rather than
 * truthiness.
 */
function rawBandOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "string") {
    const s = value.trim();
    return s.length > 0 ? s : null;
  }
  return null;
}

/** The London day of a value that is either a bare day key or an ISO instant. */
function dayOf(value: unknown): string | null {
  if (isDayKey(value)) return value;
  return londonDayOfIso(value);
}

/**
 * Normalise one raw treatment_plan_item. Returns null (a drop, counted by the
 * caller, never zeroed) only when the row has no usable id — every other field is
 * tolerated as absent because the aggregator has an honest bucket for each.
 */
export function normaliseClinicalItem(raw: unknown): NormalisedClinicalItem | null {
  const r = asRecord(raw);
  if (!r) return null;
  const id = asId(r["id"]);
  if (id === null) return null;

  const rawBand = rawBandOf(r["uda_band"]);
  const band = rawBand === null ? null : canonicalBand(rawBand);
  const completed = r["completed"] === true;

  return {
    id,
    practitionerId: asId(r["practitioner_id"]),
    band,
    rawBand,
    completed,
    completedDay: dayOf(r["completed_at"]),
    plannedDay: dayOf(r["created_at"]),
    planId: asId(r["treatment_plan_id"]),
    patientId: asId(r["patient_id"]),
  };
}

// --- The windowing rule, isolated (the load-bearing asymmetry) --------------

/**
 * THE ONE PLACE the completed/pending date asymmetry lives.
 *
 * A completed item is placed by WHEN IT WAS COMPLETED (completed_at); a pending
 * item has no completion date and is placed by WHEN IT WAS PLANNED (created_at).
 * Returns null when the relevant date is missing — a completed item with no
 * completed_at cannot be honestly placed in a window and must NOT be silently
 * re-dated to created_at (that would mix the two bases and mis-file the item).
 * The caller treats a null here as unplaceable (droppedUnreadable), never
 * as in-window.
 */
export function clinicalWindowDay(item: NormalisedClinicalItem): string | null {
  return item.completed ? item.completedDay : item.plannedDay;
}

// --- The counts each cell carries -------------------------------------------

/**
 * Three units for the same set of items, reported side by side because the brief
 * refuses to pick one: band is per-item and one course spans several bands.
 *
 *   items    — every in-scope item (summable across bands).
 *   courses  — distinct treatment_plan_id (a course of treatment). NOT summable
 *              across bands: a plan can carry items of several bands, so summing
 *              per-band course counts would double-count it. Subtotals therefore
 *              recompute from their own distinct set, never by adding cells.
 *   patients — distinct patient_id. NOT summable, for the same reason.
 *   itemsWithoutPlanId — items with no plan id, so uncountable as a course. The
 *              quantified reason `courses` is a FLOOR, not an exact figure.
 */
export interface ClinicalCounts {
  items: number;
  courses: number;
  patients: number;
  itemsWithoutPlanId: number;
}

export interface ClinicalStatePair {
  completed: ClinicalCounts;
  pending: ClinicalCounts;
}

export interface ClinicalBandCell extends ClinicalStatePair {
  band: BandKey;
}

export interface ClinicalPractitionerRow {
  practitionerId: string | null;
  bands: ClinicalBandCell[];
  total: ClinicalStatePair;
}

export interface NhsClinicalReport {
  practitioners: ClinicalPractitionerRow[];
  byBand: ClinicalBandCell[];
  grandTotal: ClinicalStatePair;

  /** Raw rows fed to the aggregator. The figure every item bucket adds back to. */
  totalItemsScanned: number;
  /** Items with no uda_band (private / non-NHS), excluded from every band cell. */
  excludedNonNhs: number;
  /** Banded items whose window day fell outside [from, to]. */
  excludedOutOfWindow: number;
  /**
   * Rows that could not be placed: no id, a duplicate id already counted, or a
   * completed item with no completed_at (unplaceable in the window). Counted and
   * surfaced, never zeroed.
   */
  droppedUnreadable: number;

  /**
   * THE INVARIANT. False means the report must render unavailable, never a total.
   * grandTotal item count (completed + pending) + the three excluded buckets ==
   * totalItemsScanned.
   */
  balanced: boolean;

  bandsPresent: BandKey[];
  filters: { window: DayWindow | null };
}

export interface NhsClinicalReportInput {
  /** Raw treatment_plan_items rows (the aggregator owns normalisation + dedup). */
  items: readonly unknown[];
  window?: DayWindow | null;
}

// --- Internal mutable accumulators ------------------------------------------

interface CountsAgg {
  items: number;
  itemsWithoutPlanId: number;
  planIds: Set<string>;
  patientIds: Set<string>;
}

interface StateAgg {
  completed: CountsAgg;
  pending: CountsAgg;
}

function emptyCounts(): CountsAgg {
  return { items: 0, itemsWithoutPlanId: 0, planIds: new Set(), patientIds: new Set() };
}

function emptyStateAgg(): StateAgg {
  return { completed: emptyCounts(), pending: emptyCounts() };
}

/** Fold one in-scope item into an accumulator. */
function addItem(agg: CountsAgg, item: NormalisedClinicalItem): void {
  agg.items += 1;
  if (item.planId === null) agg.itemsWithoutPlanId += 1;
  else agg.planIds.add(item.planId);
  if (item.patientId !== null) agg.patientIds.add(item.patientId);
}

function finalizeCounts(agg: CountsAgg): ClinicalCounts {
  return {
    items: agg.items,
    courses: agg.planIds.size,
    patients: agg.patientIds.size,
    itemsWithoutPlanId: agg.itemsWithoutPlanId,
  };
}

function finalizeState(agg: StateAgg): ClinicalStatePair {
  return { completed: finalizeCounts(agg.completed), pending: finalizeCounts(agg.pending) };
}

// --- The report -------------------------------------------------------------

/**
 * Build Report C. Every raw row is accounted for exactly once, which is what
 * makes `balanced` hold by construction and makes the NO-COUNT-VANISHES invariant
 * a real, mutation-testable check rather than a hopeful comment.
 *
 * Distinct courses and patients are tracked as SETS at every level of grouping
 * (cell, per-practitioner total, per-band, grand total) because they cannot be
 * summed from the level below — a course spanning two bands would be counted in
 * both. Item counts alone are summable, and the invariant is stated over items.
 */
export function computeNhsClinicalReport(input: NhsClinicalReportInput): NhsClinicalReport {
  const window = input.window ?? null;

  const totalItemsScanned = input.items.length;
  let excludedNonNhs = 0;
  let excludedOutOfWindow = 0;
  let droppedUnreadable = 0;

  const seen = new Set<string>();
  const byPractitioner = new Map<string | null, { bands: Map<BandKey, StateAgg>; total: StateAgg }>();
  const byBand = new Map<BandKey, StateAgg>();
  const grand = emptyStateAgg();

  const stateKey = (item: NormalisedClinicalItem): keyof StateAgg =>
    item.completed ? "completed" : "pending";

  for (const raw of input.items) {
    const item = normaliseClinicalItem(raw);
    if (item === null) {
      droppedUnreadable += 1;
      continue;
    }
    if (seen.has(item.id)) {
      // A duplicate would double-count. Drop the repeat and surface it, rather
      // than silently swallowing it (which would still balance but hide a scan bug).
      droppedUnreadable += 1;
      continue;
    }
    seen.add(item.id);

    if (item.band === null) {
      excludedNonNhs += 1;
      continue;
    }

    const day = clinicalWindowDay(item);
    if (day === null) {
      // Completed but no completed_at (or pending but no created_at): unplaceable.
      droppedUnreadable += 1;
      continue;
    }
    if (window !== null && !isDayInWindow(day, window)) {
      excludedOutOfWindow += 1;
      continue;
    }

    const key = stateKey(item);

    let prac = byPractitioner.get(item.practitionerId);
    if (!prac) {
      prac = { bands: new Map(), total: emptyStateAgg() };
      byPractitioner.set(item.practitionerId, prac);
    }
    let cell = prac.bands.get(item.band);
    if (!cell) {
      cell = emptyStateAgg();
      prac.bands.set(item.band, cell);
    }
    addItem(cell[key], item);
    addItem(prac.total[key], item);

    let bandAgg = byBand.get(item.band);
    if (!bandAgg) {
      bandAgg = emptyStateAgg();
      byBand.set(item.band, bandAgg);
    }
    addItem(bandAgg[key], item);

    addItem(grand[key], item);
  }

  const practitioners: ClinicalPractitionerRow[] = [...byPractitioner.entries()]
    .map(([practitionerId, { bands, total }]) => ({
      practitionerId,
      bands: orderBandCells(
        [...bands.entries()].map(([band, agg]) => ({ band, ...finalizeState(agg) })),
      ),
      total: finalizeState(total),
    }))
    .sort((a, b) => {
      const av = a.total.completed.items + a.total.pending.items;
      const bv = b.total.completed.items + b.total.pending.items;
      if (bv !== av) return bv - av;
      const ida = a.practitionerId ?? "";
      const idb = b.practitionerId ?? "";
      return ida < idb ? -1 : ida > idb ? 1 : 0;
    });

  const byBandCells = orderBandCells(
    [...byBand.entries()].map(([band, agg]) => ({ band, ...finalizeState(agg) })),
  );

  const grandTotal = finalizeState(grand);

  const balanced =
    grandTotal.completed.items +
      grandTotal.pending.items +
      excludedNonNhs +
      excludedOutOfWindow +
      droppedUnreadable ===
    totalItemsScanned;

  return {
    practitioners,
    byBand: byBandCells,
    grandTotal,
    totalItemsScanned,
    excludedNonNhs,
    excludedOutOfWindow,
    droppedUnreadable,
    balanced,
    bandsPresent: byBandCells.map((c) => c.band),
    filters: { window },
  };
}

function orderBandCells(cells: ClinicalBandCell[]): ClinicalBandCell[] {
  return cells.slice().sort((a, b) => BAND_KEYS.indexOf(a.band) - BAND_KEYS.indexOf(b.band));
}
