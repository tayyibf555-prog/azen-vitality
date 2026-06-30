// Review-request copy is templated and deterministic, NOT model-generated. The
// exact Google review link must be correct and the compliance constraints are
// strict, so we never risk an LLM paraphrasing the link or drifting off-script.
//
// UK compliance: warm, brief, British English, GBP £ only if ever needed, no
// em-dash, never NHS/private framing, NEVER an incentive for a review (incentivised
// reviews breach Google + ASA/CMA). One message, inviting honest feedback, with an
// easy opt-out respected by the shared suppression layer (reply STOP).

function firstName(patientName: string): string {
  return patientName.trim().split(/\s+/)[0] || "there";
}

/**
 * A compliant Google-review-request body for SMS or email.
 *
 * @param patientName  full name; only the first name is used
 * @param practiceName the practice the patient just visited
 * @param reviewLink   the practice's Google review link (from config/env)
 */
export function draftReviewRequest(
  patientName: string,
  practiceName: string,
  reviewLink: string,
): string {
  const first = firstName(patientName);
  return [
    `Hi ${first}, thank you for visiting ${practiceName} today.`,
    "If you have a moment, we would really value your honest feedback.",
    `You can leave us a Google review here: ${reviewLink}`,
    "No need to reply, and reply STOP to opt out of messages.",
  ].join(" ");
}
