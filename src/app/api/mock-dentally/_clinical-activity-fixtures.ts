// ===========================================================================
// Mock treatment_plan_items for REPORT C (NHS clinical completion).
//
// The hand-set MOCK_TREATMENT_PLAN_ITEMS in _fixtures.ts is a small, per-patient
// set for the charting panel — it is deliberately anchored in the past and keyed
// on the demo patients (pat-*). Report C scans /v1/treatment_plan_items BY
// PRACTITIONER over a date window, so on that hand-set alone it renders empty in
// dev. This file adds a date-distributed, banded population across the rostered
// practitioners so the report is non-empty locally, following the generated,
// day-seeded pattern in _finance-fixtures.ts.
//
// NOT REAL DENTALLY DATA. What IS copied from the live shape (probed read-only
// 2026-08-14) is the field grain the report reads: `completed` (bool), a
// `completed_at` present only when completed, `created_at` on every row,
// `uda_band` as bare band values with ~40% NULL (the private / non-NHS items),
// `treatment_plan_id` present on ~90% (so ~10% cannot be grouped into a course),
// and NO site_id. Ids (pat/plan) use a `c...` prefix so they never collide with
// the charting fixtures the plan-panel tests pin.
//
// DELIBERATELY MESSY, like production and like _finance-fixtures.ts:
//   - a course (shared treatment_plan_id) carries items of DIFFERENT bands at
//     once — the fact that makes "count courses by band" impossible to synthesise;
//   - some items carry NO plan id (course counts are a floor);
//   - ~40% carry no band (private) so the excluded-non-NHS reconcile is non-zero;
//   - a fifth of items are still PENDING (completed=false), which is the whole
//     point of the report and the half /v1/nhs_claims cannot show.
// ===========================================================================

import type { MockTreatmentPlanItem } from "@/app/api/mock-dentally/_fixtures";
import { ALL_PRACTITIONER_IDS } from "@/app/api/mock-dentally/_rota";
import { londonDayKey } from "@/lib/time/london";

const DAY_MS = 86_400_000;

/** How far back the population reaches — enough to fill this-quarter windows. */
const HISTORY_DAYS = 120;

// --- Deterministic pseudo-randomness (same mulberry32 as _finance-fixtures) ---

function hash32(input: string): number {
  let h = 2_166_136_261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  return h >>> 0;
}

function seeded(seed: string): () => number {
  let a = hash32(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function todayKey(): string {
  return londonDayKey(new Date());
}

function shift(dayKey: string, days: number): string {
  return new Date(Date.parse(`${dayKey}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** 0 = Sunday. Safe on a bare day key: UTC midnight is the same London date. */
function weekday(dayKey: string): number {
  return new Date(`${dayKey}T00:00:00Z`).getUTCDay();
}

/** A mid-day instant on a day, so London-day bucketing never drifts to a neighbour. */
function isoAt(dayKey: string, hour: number): string {
  return `${dayKey}T${String(hour).padStart(2, "0")}:00:00Z`;
}

/**
 * The item's band. ~40% carry no band at all (private / non-NHS -> excluded from
 * the NHS report), the rest are the bare values canonicalBand maps: 1/2/3, 4
 * (urgent) and 0 (other). Stored as STRINGS to match the mock's own
 * MockTreatmentPlanItem shape (`uda_band: string | null`).
 */
function pickBand(rand: () => number): string | null {
  const roll = rand();
  if (roll < 0.4) return null; // private / non-NHS
  if (roll < 0.62) return "1";
  if (roll < 0.8) return "2";
  if (roll < 0.88) return "3";
  if (roll < 0.95) return "4"; // urgent
  return "0"; // other
}

function bandCategory(band: string | null): string | null {
  switch (band) {
    case "1":
      return "Band 1";
    case "2":
      return "Band 2";
    case "3":
      return "Band 3";
    case "4":
      return "Urgent";
    case "0":
      return "Other";
    default:
      return null;
  }
}

function buildItem(args: {
  id: string;
  practitionerId: string;
  patientId: string;
  planId: string | null;
  band: string | null;
  completed: boolean;
  createdDay: string;
  completedDay: string | null;
}): MockTreatmentPlanItem {
  const { id, practitionerId, patientId, planId, band, completed, createdDay, completedDay } = args;
  const completedAt = completed && completedDay ? isoAt(completedDay, 12) : null;
  // updated_at drives the report's `updated_since` fetch superset: a completed
  // item is last touched when completed, a pending one on the day it was planned.
  const updatedDay = completed && completedDay ? completedDay : createdDay;
  return {
    id,
    patient_id: patientId,
    treatment_plan_id: planId,
    treatment_appointment_id: null,
    treatment_id: null,
    practitioner_id: practitionerId,
    teeth: [],
    surfaces: "",
    region: null,
    base_chart: false,
    completed,
    completed_at: completedAt,
    charged: false,
    notes: null,
    nomenclature: band ? "NHS treatment" : "Private treatment",
    patient_nomenclature: "Treatment",
    price: 0,
    value: 0,
    duration: 20,
    nhs_treatment_cat: bandCategory(band),
    uda_band: band,
    payment_plan_id: band ? 1 : 2,
    position: 1,
    created_at: isoAt(createdDay, 10),
    updated_at: isoAt(updatedDay, band && completed ? 12 : 10),
  };
}

function itemsForPractitionerDay(practitionerId: string, day: string): MockTreatmentPlanItem[] {
  const dow = weekday(day);
  if (dow === 0) return []; // closed Sundays
  const rand = seeded(`clinical|${practitionerId}|${day}`);
  // 0-2 courses per clinician-day (weighted low so the whole set stays small).
  const courseRoll = rand();
  const courseCount = courseRoll < 0.55 ? 0 : courseRoll < 0.85 ? 1 : 2;
  const rows: MockTreatmentPlanItem[] = [];

  for (let c = 0; c < courseCount; c += 1) {
    const patientId = `cpat-${hash32(`${practitionerId}|${day}|${c}`) % 100_000}`;
    // ~10% of items carry no plan id; model it as a course with no plan.
    const hasPlan = rand() >= 0.1;
    const planId = hasPlan ? `cplan-${practitionerId}-${day}-${c}` : null;
    const itemCount = 1 + Math.floor(rand() * 3); // 1-3 items per course
    for (let i = 0; i < itemCount; i += 1) {
      const band = pickBand(rand);
      // ~22% of items are still pending. Completed items resolve a few days after
      // they were planned; pending items were planned on `day`.
      const completed = rand() >= 0.22;
      const createdDay = shift(day, -Math.floor(rand() * 10));
      rows.push(
        buildItem({
          id: `ctpi-${practitionerId}-${day}-${c}-${i}`,
          practitionerId,
          patientId,
          planId,
          band,
          completed,
          createdDay,
          completedDay: completed ? day : null,
        }),
      );
    }
  }
  return rows;
}

function build(today: string): MockTreatmentPlanItem[] {
  const rows: MockTreatmentPlanItem[] = [];
  for (let back = 0; back < HISTORY_DAYS; back += 1) {
    const day = shift(today, -back);
    for (const practitionerId of ALL_PRACTITIONER_IDS) {
      rows.push(...itemsForPractitionerDay(practitionerId, day));
    }
  }
  // Newest first, as the live API returns them (default updated_at desc).
  rows.sort((a, b) => (a.updated_at === b.updated_at ? (a.id < b.id ? 1 : -1) : a.updated_at < b.updated_at ? 1 : -1));
  return rows;
}

let cache: { day: string; rows: MockTreatmentPlanItem[] } | null = null;

/**
 * The generated clinical-activity population, rebuilt once per London day so the
 * "this month" window is always meaningful whenever dev is run. Kept SEPARATE from
 * the charting const so the plan-panel fixture tests are untouched.
 */
export function clinicalActivityItems(): MockTreatmentPlanItem[] {
  const today = todayKey();
  if (cache?.day !== today) cache = { day: today, rows: build(today) };
  return cache.rows;
}
