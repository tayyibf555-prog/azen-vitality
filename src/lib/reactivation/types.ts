export type ReactivationReason = "lapsed" | "overdue_recall" | "stalled_plan";
export type ReactivationStatus = "dormant" | "in_cadence" | "converted" | "exhausted";
export type CadenceStatus =
  | "active"
  | "awaiting_approval"
  | "paused"
  | "converted"
  | "exhausted";
export type TouchChannel = "sms" | "email" | "whatsapp";
export type TouchStatus = "draft" | "approved" | "queued" | "sent" | "failed";
export type DraftedBy = "claude" | "human";

export interface ReactivationTarget {
  id: string;                  // `${siteId}:${dentallyPatientId}`
  siteId: string;
  dentallyPatientId: string;
  patientName: string;
  reason: ReactivationReason;
  dentallyPlanId: string | null;
  treatment: string | null;
  recoverableValue: number;    // GBP
  lastVisitAt: string | null;  // ISO
  recallDueAt: string | null;  // ISO
  priorAttempts: number;
  status: ReactivationStatus;
  reactivationScore: number;
  consent: { sms: boolean; email: boolean; marketing: boolean };
  updatedFromDentallyAt: string;
}

export interface ReactivationCadence {
  id: string;
  targetId: string;
  siteId: string;
  currentStep: number;         // last completed step; 0 = enrolled, none sent
  status: CadenceStatus;
  nextDueAt: string | null;    // ISO
  startedAt: string;
  endedAt: string | null;
  updatedAt: string;
}

export interface ReactivationTouch {
  id: string;
  targetId: string;
  cadenceId: string;
  siteId: string;
  step: number;
  channel: TouchChannel;
  direction: "outbound" | "inbound";
  body: string;
  draftedBy: DraftedBy;
  status: TouchStatus;
  approvedBy: string | null;
  createdAt: string;
  sentAt: string | null;
}

export interface ReactivationOutboxItem {
  id: string;
  touchId: string;
  siteId: string;
  channel: TouchChannel;
  toRef: string;
  body: string;
  status: "queued" | "sent" | "failed";
  provider: string | null;
  createdAt: string;
  sentAt: string | null;
}
