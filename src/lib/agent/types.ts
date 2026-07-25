export type ConversationStatus = "active" | "needs_human" | "booked" | "closed";
export type MessageRole = "patient" | "agent" | "system" | "tool";

export interface AgentConversation {
  id: string;
  siteId: string;
  dentallyPatientId: string;
  patientName: string;
  channel: string;
  status: ConversationStatus;
  treatment: string | null;
  fundingType: "nhs" | "private" | null;
  lastInboundAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentMessageRow {
  id: string;
  conversationId: string;
  role: MessageRole;
  body: string;
  toolName: string | null;
  createdAt: string;
}

/** Patient context handed to the agent for a turn. */
export interface AgentContext {
  patientId: string;
  siteId: string;
  /** The inbound mobile number, used to onboard a new patient. */
  phone?: string | null;
  /**
   * The channel this conversation is actually happening on ("sms" or "whatsapp").
   * The prompt names it to the patient, so getting it wrong makes the agent tell a
   * WhatsApp user it is texting them. Defaults to SMS when absent.
   */
  channel?: string | null;
  patientName: string;
  treatment: string | null;
  fundingType: "nhs" | "private" | null;
  /** Last completed visit / checkup, if known. */
  lastVisitAt?: string | null;
  /** When their recall is (or was) due, if known. */
  recallDueAt?: string | null;
  /**
   * Whether we matched this number to a patient on record. When false the
   * agent treats it as a brand new enquiry and does not claim to know them.
   */
  isKnownPatient?: boolean;
  /** The practice's active USP texts, woven into the prompt for conversion. */
  usps?: string[];
  /**
   * "Question => answer" lines from the smile assessment, when this conversation
   * is with a lead who completed one. Grounds the agent in what they told us.
   */
  assessmentAnswers?: string[];
  /**
   * The group's practices (+ public booking link where online booking is on), so
   * the agent can ask a new enquiry where they are based and point them at the
   * most convenient practice. It can only search/book at its own siteId.
   */
  practiceSites?: { id: string; name: string; bookingUrl?: string }[];
  /**
   * Present when this conversation is a reply to a segment-outreach invite. It
   * primes the agent to offer the invited clinician's slots first (find_slots
   * defaults to this practitioner when set) and to frame the visit around the
   * campaign's treatment angle. `treatmentAngle` is patient-facing safe wording.
   */
  outreachInvite?: {
    treatmentAngle: string;
    practitionerName: string | null;
    practitionerId: string | null;
  };
}

/** A patient resolved from an inbound phone number. */
export interface PhoneIdentity {
  patientId: string;
  siteId: string;
  patientName: string;
  treatment: string | null;
  fundingType: "nhs" | "private" | null;
  lastVisitAt: string | null;
  recallDueAt: string | null;
  /** Where the match came from, for logging / trust. */
  source: "directory" | "reactivation" | "dentally";
}

export interface AgentTurnResult {
  replyText: string;
  toolCalls: { name: string; input: Record<string, unknown> }[];
  escalated: boolean;
}
