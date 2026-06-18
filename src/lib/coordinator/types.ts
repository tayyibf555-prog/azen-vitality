export type OpportunityStatus = "accepted" | "in_progress" | "stalled" | "completed";
export type TouchChannel = "sms" | "email" | "whatsapp";
export type TouchStatus = "draft" | "approved" | "queued" | "sent" | "failed";
export type DraftedBy = "claude" | "human";

export interface TreatmentOpportunity {
  id: string;
  siteId: string;
  dentallyPatientId: string;
  dentallyPlanId: string;
  patientName: string;
  treatment: string;
  plannedValue: number;       // GBP
  amountOutstanding: number;  // GBP
  acceptedAt: string;         // ISO
  status: OpportunityStatus;
  financePresented: boolean;
  lastTouchAt: string | null; // ISO
  priorityScore: number;
  consent: { sms: boolean; email: boolean; marketing: boolean };
  updatedFromDentallyAt: string;
}

export interface CoordinatorTouch {
  id: string;
  opportunityId: string;
  siteId: string;
  channel: TouchChannel;
  direction: "outbound" | "inbound";
  body: string;
  draftedBy: DraftedBy;
  status: TouchStatus;
  approvedBy: string | null;
  createdAt: string;
  sentAt: string | null;
}

export interface OutboxItem {
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
