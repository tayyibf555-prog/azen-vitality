// ---------------------------------------------------------------------------
// The APPOINTMENTS panel: the donut. Completed, Cancelled, DNA, and the total.
//
// The donut stays. The owner considered replacing it and decided against, and
// familiarity is the point: she reads this shape every morning in Dentally.
//
// Dentally's appointment state vocabulary is a set of words, not an enum we
// control, and the group has years of historic rows. So an unrecognised state is
// NEVER quietly filed under one of the three buckets. It lands in `other` and
// the raw word is reported in `unknownStates`, so a miscount shows up as a
// calibration job rather than as three subtly wrong slices.
//
// Pure functions only.
// ---------------------------------------------------------------------------

import type { DashboardAppointment } from "@/lib/dashboard/normalise";
import { isDayInWindow, type DayWindow } from "@/lib/dashboard/period";

/** Reduce a Dentally state to a comparable key: lower case, single underscores. */
export function stateKey(state: string): string {
  return state
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const COMPLETED = new Set(["completed", "complete", "attended", "finished"]);
const CANCELLED = new Set([
  "cancelled",
  "canceled",
  "cancelled_by_patient",
  "cancelled_by_practice",
  "cancelled_by_practitioner",
]);
const DNA = new Set(["did_not_attend", "dna", "no_show", "failed_to_attend", "fta"]);

/**
 * States that are legitimately neither completed, cancelled nor missed: an
 * appointment still ahead of itself, or in the chair. Recognised so they are not
 * reported as unknown, but counted in `other`, not in a donut slice.
 */
const IN_FLIGHT = new Set([
  "booked",
  "pending",
  "unconfirmed",
  "confirmed",
  "arrived",
  "checked_in",
  "in_surgery",
  "in_treatment",
  "waiting",
  "seen",
]);

export type OutcomeBucket = "completed" | "cancelled" | "dna" | "other";

/** Which donut slice a raw state belongs to, and whether we recognised it at all. */
export function classifyState(state: string): { bucket: OutcomeBucket; recognised: boolean } {
  const key = stateKey(state);
  if (COMPLETED.has(key)) return { bucket: "completed", recognised: true };
  if (CANCELLED.has(key)) return { bucket: "cancelled", recognised: true };
  if (DNA.has(key)) return { bucket: "dna", recognised: true };
  if (IN_FLIGHT.has(key)) return { bucket: "other", recognised: true };
  return { bucket: "other", recognised: false };
}

export interface OutcomeSplit {
  completed: number;
  cancelled: number;
  dna: number;
  /** Everything still in flight, plus anything unrecognised. Not a donut slice. */
  other: number;
  /** Every appointment in the window, including `other`. The donut's centre figure. */
  total: number;
  /** Raw states we did not recognise, deduplicated and sorted, for calibration. */
  unknownStates: string[];
}

export interface OutcomeSplitInput {
  appointments: readonly DashboardAppointment[];
  window: DayWindow;
  /** Scope to one site, or null for the whole group. */
  siteId?: string | null;
  /** Scope to one practitioner (the "Everyone" filter), or null for all. */
  practitionerId?: string | null;
}

/** Count the donut. */
export function computeOutcomeSplit(input: OutcomeSplitInput): OutcomeSplit {
  const siteId = input.siteId ?? null;
  const practitionerId = input.practitionerId ?? null;

  let completed = 0;
  let cancelled = 0;
  let dna = 0;
  let other = 0;
  const unknown = new Set<string>();

  for (const a of input.appointments) {
    if (!isDayInWindow(a.day, input.window)) continue;
    if (siteId !== null && a.siteId !== siteId) continue;
    if (practitionerId !== null && a.practitionerId !== practitionerId) continue;

    const { bucket, recognised } = classifyState(a.state);
    if (!recognised) unknown.add(a.state);
    if (bucket === "completed") completed += 1;
    else if (bucket === "cancelled") cancelled += 1;
    else if (bucket === "dna") dna += 1;
    else other += 1;
  }

  return {
    completed,
    cancelled,
    dna,
    other,
    total: completed + cancelled + dna + other,
    unknownStates: [...unknown].sort(),
  };
}

/**
 * Distinct patients with a COMPLETED appointment in the window: the "seen" count
 * on the patients panel. Kept here because it reads the same appointment set.
 */
export function countPatientsSeen(input: OutcomeSplitInput): number {
  const siteId = input.siteId ?? null;
  const seen = new Set<string>();
  for (const a of input.appointments) {
    if (!isDayInWindow(a.day, input.window)) continue;
    if (siteId !== null && a.siteId !== siteId) continue;
    if (a.patientId === null) continue;
    if (classifyState(a.state).bucket !== "completed") continue;
    seen.add(a.patientId);
  }
  return seen.size;
}
