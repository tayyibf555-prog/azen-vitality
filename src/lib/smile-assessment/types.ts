// Smile Assessment domain types.
//
// One AssessmentResponse per quiz submission. The score is intent/fit only; a
// high band fast-tracks the enquiry into the Speed-to-lead pipeline (lead_id is
// stamped once that lead exists). Medium and low scorers are recorded for nurture.

import type { AssessmentBand } from "./scoring";

export type { AssessmentBand };

/** Preferred reply channel captured on the quiz. */
export type AssessmentChannel = "sms" | "email" | "whatsapp";

/** The full smile_assessment_response row. */
export interface AssessmentResponse {
  id: string;
  siteId: string;
  leadId: string | null;
  firstName: string;
  email: string | null;
  phone: string | null;
  channel: AssessmentChannel | null;
  treatmentInterest: string | null;
  responses: Record<string, string>;
  rawScore: number;
  band: AssessmentBand;
  source: string;
  createdAt: string; // ISO
}
