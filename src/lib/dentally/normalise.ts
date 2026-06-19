import type { OpportunityStatus, TreatmentOpportunity } from "@/lib/coordinator/types";

export interface DentallyPlanInput {
  siteId: string;
  // Consent fields mirror Dentally's real patient object: top-level use_sms /
  // use_email booleans and a marketing integer (0/1). See developer.dentally.co.
  patient: {
    id: string; first_name: string; last_name: string;
    use_sms?: boolean; use_email?: boolean; marketing?: number | boolean;
  };
  plan: { id: string; name: string; planned_private_treatment_value: number; accepted_at: string };
  amountOutstanding: number;
  lastTouchAt: string | null;
}

const DAY = 86_400_000;

function deriveStatus(i: DentallyPlanInput, now: Date): OpportunityStatus {
  if (i.amountOutstanding <= 0) return "completed";
  if (i.amountOutstanding < i.plan.planned_private_treatment_value) return "in_progress";
  const ageDays = (now.getTime() - new Date(i.plan.accepted_at).getTime()) / DAY;
  if (!i.lastTouchAt && ageDays > 30) return "stalled";
  return "accepted";
}

export function toOpportunity(i: DentallyPlanInput, now: Date): TreatmentOpportunity {
  return {
    id: `${i.siteId}:${i.plan.id}`,
    siteId: i.siteId,
    dentallyPatientId: i.patient.id,
    dentallyPlanId: i.plan.id,
    patientName: `${i.patient.first_name} ${i.patient.last_name}`.trim(),
    treatment: i.plan.name,
    plannedValue: i.plan.planned_private_treatment_value,
    amountOutstanding: i.amountOutstanding,
    acceptedAt: i.plan.accepted_at,
    status: deriveStatus(i, now),
    financePresented: false,
    lastTouchAt: i.lastTouchAt,
    priorityScore: 0,
    consent: {
      sms: Boolean(i.patient.use_sms),
      email: Boolean(i.patient.use_email),
      marketing: Boolean(i.patient.marketing),
    },
    updatedFromDentallyAt: now.toISOString(),
  };
}
