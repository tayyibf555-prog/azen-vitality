// No-show defence domain types.
//
// The channel / touch / cadence-status unions are shared with reactivation so
// the reused outbox + drain contracts stay identical. No-show adds its own
// target/cadence shapes keyed by appointment, plus a waitlist + slot-offer model
// for auto-filling cancellations.

export type {
  TouchChannel,
  TouchStatus,
  DraftedBy,
} from "@/lib/reactivation/types";

// No-show cadences gain confirmed/cancelled terminal states (a patient settles
// their appointment) on top of the shared lifecycle.
export type NoshowCadenceStatus =
  | "active"
  | "paused"
  | "confirmed"
  | "cancelled"
  | "exhausted";

// scheduled -> upcoming, defending against a no-show (confirmations running)
// confirmed -> patient confirmed they are coming
// cancelled -> patient cancelled (slot freed, waitlist may fill it)
// attended  -> they showed up
// no_show   -> they did not attend
export type NoshowStatus =
  | "scheduled"
  | "confirmed"
  | "cancelled"
  | "attended"
  | "no_show";

export type RiskBand = "low" | "medium" | "high";

export interface NoshowTarget {
  id: string;                  // `${siteId}:${dentallyPatientId}:${appointmentId}`
  siteId: string;
  dentallyPatientId: string;
  appointmentId: string;
  patientName: string;
  appointmentStartAt: string;  // ISO
  appointmentState: string;    // raw Dentally state
  durationMin: number;
  practitioner: string | null;
  riskScore: number;           // 0-100
  riskBand: RiskBand;
  status: NoshowStatus;
  priorAttempts: number;
  consent: { sms: boolean; email: boolean; marketing: boolean };
  updatedFromDentallyAt: string;
}

export interface NoshowCadence {
  id: string;
  targetId: string;
  siteId: string;
  currentStep: number;         // last completed step; 0 = enrolled, none sent
  status: NoshowCadenceStatus;
  nextDueAt: string | null;    // ISO
  startedAt: string;
  endedAt: string | null;
  updatedAt: string;
}

export type WaitlistStatus = "waiting" | "offered" | "booked" | "removed";

export interface WaitlistEntry {
  id: string;
  siteId: string;
  dentallyPatientId: string;
  patientName: string;
  treatment: string | null;
  practitionerPref: string | null;
  earliestAt: string | null;   // ISO, acceptable window (null = any)
  latestAt: string | null;
  durationMin: number;
  consent: { sms: boolean; email: boolean; marketing: boolean };
  status: WaitlistStatus;
  createdAt: string;
}

/** A slot freed by a cancellation, to be offered to the waitlist. */
export interface FreedSlot {
  appointmentId: string;
  siteId: string;
  startAt: string;             // ISO
  durationMin: number;
  practitioner: string | null;
}

export type SlotOfferStatus = "offered" | "accepted" | "declined" | "expired" | "filled";

export interface SlotOffer {
  id: string;
  siteId: string;
  waitlistId: string;
  dentallyPatientId: string;
  freedAppointmentId: string;
  freedStartAt: string;
  durationMin: number;
  practitioner: string | null;
  touchId: string | null;
  status: SlotOfferStatus;
  offeredAt: string;
  expiresAt: string;
  respondedAt: string | null;
}
