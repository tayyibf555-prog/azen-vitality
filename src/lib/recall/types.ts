// Recall concierge domain types.
//
// The channel / touch / cadence-status unions are shared with reactivation so
// the reused outbox + drain contracts stay identical. Recall adds its own
// target/cadence shapes keyed by recall type (dentist vs hygienist).

export type {
  TouchChannel,
  TouchStatus,
  CadenceStatus,
  DraftedBy,
} from "@/lib/reactivation/types";

export type RecallType = "dentist" | "hygienist";

// due       -> classified, not yet enrolled
// in_cadence-> enrolled, cadence running
// converted -> booked back in
// exhausted -> cadence ran out within the recall window (no graduation)
// graduated -> cadence ran out and the recall crossed the grace boundary;
//              reactivation legitimately adopts it from here.
export type RecallStatus =
  | "due"
  | "in_cadence"
  | "converted"
  | "exhausted"
  | "graduated";

export interface RecallTarget {
  id: string;                  // `${siteId}:${dentallyPatientId}:${recallType}`
  siteId: string;
  dentallyPatientId: string;
  patientName: string;
  recallType: RecallType;
  dueAt: string;               // ISO, the recall date set in Dentally
  overdueDays: number;         // (now - dueAt) in whole days; negative = due soon
  lastVisitAt: string | null;  // ISO
  priorAttempts: number;
  status: RecallStatus;
  consent: { sms: boolean; email: boolean; marketing: boolean };
  updatedFromDentallyAt: string;
}

export interface RecallCadence {
  id: string;
  targetId: string;
  siteId: string;
  currentStep: number;         // last completed step; 0 = enrolled, none sent
  status: import("@/lib/reactivation/types").CadenceStatus;
  nextDueAt: string | null;    // ISO
  startedAt: string;
  endedAt: string | null;
  updatedAt: string;
}
