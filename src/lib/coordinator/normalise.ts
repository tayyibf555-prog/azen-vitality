// Pure mapping from a Dentally treatment plan + patient into a TreatmentOpportunity.
// No I/O, fully unit-tested. Plans that are completed, declined, or have nothing
// left to pay are not opportunities and are skipped.

import { priorityScore, rankOpportunities } from "./scoring";
import type { TreatmentOpportunity } from "./types";

export { rankOpportunities };

export interface PlanInput {
  id: string;
  name: string;
  plannedValue: number;
  /**
   * GBP still to be done on this plan. Live Dentally exposes no outstanding /
   * balance field at all, so for a plan it reports as incomplete this is the whole
   * private treatment value; a plan it reports as completed is 0. Where a source
   * does carry an explicit outstanding figure (the local mock), that wins.
   */
  amountOutstanding: number;
  acceptedAt: string;       // ISO
  // Optional lifecycle hint from Dentally. When present, a completed/declined
  // plan is not an opportunity. The mock signals completion via outstanding == 0.
  status?: string | null;
  /** Live Dentally's own completion flag. A completed plan is never an opportunity. */
  completed?: boolean;
  financePresented?: boolean;
}

export interface PatientInput {
  id: string;
  first_name: string;
  last_name: string;
  use_sms?: boolean;
  use_email?: boolean;
  marketing?: number | boolean;
}

export interface CoordinatorInput {
  siteId: string;
  patient: PatientInput;
  plan: PlanInput;
  lastTouchAt: string | null;
}

/** Lifecycle words that mean the plan is no longer an open opportunity. */
const TERMINAL_STATUSES = new Set(["completed", "complete", "declined", "rejected", "cancelled"]);

/**
 * Map a single Dentally treatment plan + patient into a TreatmentOpportunity, or
 * null when the plan is not an opportunity: Dentally's own `completed` flag, a
 * terminal status (completed/declined), or nothing left outstanding.
 */
export function toTreatmentOpportunity(
  i: CoordinatorInput,
  now: Date,
): TreatmentOpportunity | null {
  if (i.plan.completed === true) return null;
  const status = (i.plan.status ?? "").toLowerCase();
  if (TERMINAL_STATUSES.has(status)) return null;
  if (!(i.plan.amountOutstanding > 0)) return null;

  const patientName = `${i.patient.first_name} ${i.patient.last_name}`.trim();
  const opportunity: TreatmentOpportunity = {
    id: `${i.siteId}:${i.patient.id}:${i.plan.id}`,
    siteId: i.siteId,
    dentallyPatientId: i.patient.id,
    dentallyPlanId: i.plan.id,
    patientName,
    treatment: i.plan.name,
    plannedValue: i.plan.plannedValue,
    amountOutstanding: i.plan.amountOutstanding,
    acceptedAt: i.plan.acceptedAt,
    status: "accepted",
    financePresented: Boolean(i.plan.financePresented),
    lastTouchAt: i.lastTouchAt,
    priorityScore: 0,
    consent: {
      sms: Boolean(i.patient.use_sms),
      email: Boolean(i.patient.use_email),
      marketing: Boolean(i.patient.marketing),
    },
    updatedFromDentallyAt: now.toISOString(),
  };
  // Stamp the score now so a single mapped opportunity already carries it.
  opportunity.priorityScore = priorityScore(opportunity, now);
  return opportunity;
}

/**
 * Map a batch of plans + patients, dropping the ones that are not opportunities,
 * then rank by recovery value (highest priority first).
 */
export function toRankedOpportunities(
  inputs: CoordinatorInput[],
  now: Date,
): TreatmentOpportunity[] {
  const mapped: TreatmentOpportunity[] = [];
  for (const i of inputs) {
    const o = toTreatmentOpportunity(i, now);
    if (o) mapped.push(o);
  }
  return rankOpportunities(mapped, now);
}
