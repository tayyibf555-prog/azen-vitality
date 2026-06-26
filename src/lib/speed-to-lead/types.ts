// Speed-to-lead domain types.
//
// The dashboard-facing shape is the existing @/lib/types `Lead`. The full DB row
// (SpeedToLeadLead) carries everything the intake + sweep + contact pipeline
// needs; toDashboardLead narrows it to the shared Lead the worklist renders.

import type { Lead, LeadStage, Channel } from "@/lib/types";

export type { LeadStage, Channel };

/** First-contact channel actually used to send (email folds to nothing special). */
export type LeadChannel = "sms" | "email" | "whatsapp";

/** Consent flags captured at intake (a patient who enquired consents to a reply). */
export interface LeadConsent {
  sms?: boolean;
  email?: boolean;
  whatsapp?: boolean;
  marketing?: boolean;
}

/** The full speed_to_lead_lead row. */
export interface SpeedToLeadLead {
  id: string;
  siteId: string;
  dentallyPatientId: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  channel: LeadChannel;
  treatmentInterest: string | null;
  source: string;
  score: number | null;
  stage: LeadStage;
  consent: LeadConsent;
  createdAt: string;          // ISO
  firstResponseAt: string | null; // ISO, when first contact went out
  conversationId: string | null;
  updatedAt: string;
}

/** One outbound first-contact attempt. */
export interface SpeedToLeadAttempt {
  id: string;
  leadId: string;
  channel: LeadChannel;
  toAddress: string;
  body: string;
  status: "sent" | "failed";
  provider: string | null;
  providerMessageId: string | null;
  createdAt: string;
}

/** Seconds from enquiry to first contact, or null if not yet contacted. */
export function firstResponseSeconds(row: SpeedToLeadLead): number | null {
  if (!row.firstResponseAt) return null;
  const ms = new Date(row.firstResponseAt).getTime() - new Date(row.createdAt).getTime();
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.round(ms / 1000));
}

/** Map a DB row to the shared dashboard Lead shape. */
export function toDashboardLead(row: SpeedToLeadLead): Lead {
  return {
    id: row.id,
    siteId: row.siteId,
    name: row.name,
    stage: row.stage,
    assessmentScore: row.score,
    // The shared Lead requires a string; empty when no interest was captured.
    treatmentInterest: row.treatmentInterest ?? "",
    source: row.source,
    createdAt: row.createdAt,
    firstResponseSeconds: firstResponseSeconds(row),
    // The shared Channel union includes "phone"; our first-contact channels are a subset.
    channel: row.channel as Channel,
  };
}
