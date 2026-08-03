// ===========================================================================
// THE CHARTING CONTRACT.
//
// Types only. No logic, no I/O, and there is NO index.ts barrel in this
// directory: a barrel would let the client workspace reach the server-only
// draft repository (src/lib/patient-chart/), which builds green and then drags
// the service-role client into the client graph.
//
// The chart is a READ-ONLY MIRROR of Dentally. Everything here describes what
// Dentally returned from /v1/treatment_plan_items and what we chose to draw
// from it. Nothing here is written back: Dentally publishes no create route on
// any charting resource.
//
// FUNDING IS NOT REDEFINED HERE. src/lib/calendar/funding.ts already owns that
// vocabulary and its own comment explains that a second hand-written list is
// exactly how two screens drift, so FundingCode is imported and re-exported.
// ===========================================================================

import type { FundingCode } from "@/lib/calendar/funding";

export type Dentition = "permanent" | "deciduous" | "base" | "combined";
export type SurfaceId = "mesial" | "occlusal" | "distal" | "buccal" | "lingual";
export type BoxSide = "top" | "right" | "bottom" | "left" | "centre";

/**
 * One row of /v1/treatment_plan_items, mapped.
 *
 * `rawTeeth` and `rawSurfaces` are kept verbatim beside the parsed values: when
 * the parser cannot place a finding, the screen shows what Dentally actually
 * said rather than silently showing nothing.
 */
export interface ChartItem {
  id: string;
  teeth: number[];
  rawTeeth: string;
  /** Surfaces named as LETTERS. The local mock and our own draft table speak this
   *  way; live Dentally does not, so on a real patient this is empty. */
  surfaces: SurfaceId[];
  rawSurfaces: string;
  /**
   * Surfaces named as Dentally's own INTEGERS — 1-5, and 1-8 on a permanent molar.
   * This is the ONLY form live Dentally sends (CHARTING.md §2.6, measured across
   * production), so it is what fills a real patient's chart.
   *
   * REQUIRED, NOT OPTIONAL, and that is the point of it being here rather than
   * attached at the mapper. It was carried for a while as a field bolted onto the
   * shape from outside, which meant a consumer that simply forgot it compiled
   * perfectly and drew a clean, unmarked tooth for a real restoration. A required
   * field makes forgetting it a compiler error instead of a blank chart.
   *
   * Every index here is placeable on at least ONE of `teeth`; one that is placeable
   * on none of them goes to `unrecognisedSurfaces` instead, never clamped onto a
   * nearby region.
   */
  surfaceIndices: number[];
  /** Surface values Dentally sent that we could not place at all: an unknown
   *  letter, an unreadable word, an integer outside 1-8, or an index outside the
   *  scheme of every tooth the row names. KEPT, never dropped. */
  unrecognisedSurfaces: string[];
  /** Parseable teeth and no surfaces: extraction, crown, bridge, endo, implant.
   *  A computed field, so nothing downstream has to infer it and get it wrong. */
  wholeTooth: boolean;
  region: string | null;
  baseChart: boolean;
  completed: boolean;
  completedAt: string | null;
  charged: boolean;
  notes: string | null;
  /** The STAFF code. Never patient_nomenclature, which is the patient's wording. */
  nomenclature: string | null;
  price: number;
  value: number;
  durationMin: number;
  nhsTreatmentCat: string | null;
  udaBand: string | null;
  position: number;
  planId: string | null;
  treatmentId: string | null;
  practitionerId: string | null;
  paymentPlanId: number | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface TreatmentRow {
  id: string;
  code: string;
  name: string;
  categoryId: string | null;
  price: number;
}

export interface TreatmentCategoryRow {
  id: string;
  name: string;
}

export interface PlanRow {
  id: string;
  label: string;
  status: "accepted" | "unaccepted" | "completed";
  acceptedAt: string | null;
}

/** One flag per read. A stream that failed must be able to say so on its own:
 *  "we could not read the plans" and "this patient has no plans" are different
 *  clinical statements. */
export interface ChartReadHealth {
  items: "ok" | "failed";
  treatments: "ok" | "failed";
  categories: "ok" | "failed";
  plans: "ok" | "failed";
}

export interface ChartRead {
  items: ChartItem[];
  /** Rows whose teeth would not parse. Counted and listed, never dropped. */
  unplaced: ChartItem[];
  treatments: TreatmentRow[];
  categories: TreatmentCategoryRow[];
  plans: PlanRow[];
  /** THIS PATIENT'S chart hit its page ceiling, so the chart on screen may not
   *  be the whole of it. */
  truncated: boolean;
  /** The practice-wide treatment catalogue, its categories or the plan list hit
   *  their ceiling. Kept apart from `truncated` because they say different
   *  things: one shared flag put "this may not be the whole of this patient's
   *  chart" on every patient of any practice whose stock treatment list runs
   *  past 500 rows, and a caveat that is always on is a caveat nobody reads. */
  truncatedCatalogue: boolean;
  /** Captured at FETCH time, not render time, so the as-of line is honest to
   *  the read rather than to whenever React happened to run. */
  fetchedAt: string;
  health: ChartReadHealth;
}

/**
 * What put a mark on this surface. FIVE origins, and the four Dentally ones are
 * visually distinct: an item on a plan the patient never accepted must not
 * render identically to one on the live accepted plan.
 */
export type SurfaceOrigin =
  | "dentally-completed"
  | "dentally-planned"
  | "dentally-unaccepted"
  | "dentally-base"
  | "draft"
  | "none";

export interface SurfaceStyle {
  /** A CSS custom property NAME, or null for no fill. Never a Tailwind class. */
  fillVar: string | null;
  lineVar: string;
  dashed: boolean;
  glyph: "none" | "draft";
  label: string;
}

export interface ToothMark {
  origin: SurfaceOrigin;
  nomenclature: string | null;
  itemId: string;
}

export interface DraftEntry {
  tooth: number;
  surfaces: SurfaceId[];
  treatmentCode: string;
  treatmentName: string;
  dentition: "permanent" | "deciduous";
}

export type ChartRejection =
  | "no-treatment-selected"
  | "no-first-surface"
  | "chart-locked"
  | "tooth-not-in-arch"
  | "base-chart-is-read-only"
  | "draft-disabled";

export interface ChartRejectionEvent {
  reason: ChartRejection;
  tooth: number | null;
  surface: SurfaceId | null;
  /** Makes two identical consecutive rejections DIFFERENT states, so an
   *  aria-live region re-announces rather than going quiet on the second try. */
  nonce: number;
}

export interface ChartState {
  dentition: Dentition;
  activeTreatment: { code: string; name: string } | null;
  activeTooth: number | null;
  activePlanId: string | null;
  locked: boolean;
  draftEnabled: boolean;
  /** key `${tooth}:${treatmentCode}` */
  draft: Record<string, DraftEntry>;
  /** One step. `entry: null` means "there was nothing here", so undo removes. */
  undo: { key: string; entry: DraftEntry | null } | null;
  lastRejection: ChartRejectionEvent | null;
  rejectionSeq: number;
}

export type ChartIntent =
  | { kind: "chart-first"; tooth: number; surface: SurfaceId }
  | { kind: "chart-add"; tooth: number; surface: SurfaceId }
  | { kind: "select-treatment"; code: string; name: string }
  | { kind: "set-dentition"; dentition: Dentition }
  | { kind: "select-plan"; planId: string | null }
  | { kind: "clear-tooth"; tooth: number }
  | { kind: "set-locked"; locked: boolean }
  | { kind: "undo" }
  | { kind: "hydrate"; draft: Record<string, DraftEntry> };

export interface ChartPreferences {
  locked: boolean;
  combined: boolean;
  hover: boolean;
  panelCollapsed: boolean;
  favouritesFirst: boolean;
  sort: "name" | "code";
}

export type { FundingCode };
