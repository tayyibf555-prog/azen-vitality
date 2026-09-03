import { fundingFromPlanId } from "@/lib/calendar/funding";
import type { TriageFork } from "./types";

// ===========================================================================
// THE FORK. Which of the two question banks a patient is asked.
//
// PURE. No I/O, no clock, no env. It takes a payment plan id and returns "full"
// or "brief". Everything about WHY lives here so the rule can be read in one
// place and tested directly.
//
// ---------------------------------------------------------------------------
// THE RULE, AND WHY IT FAILS TO THE SHORT LIST.
// ---------------------------------------------------------------------------
//
// The practice's own contractual position: an NHS-plan patient must not be ASKED
// a pain / symptom / treatment-need question ahead of their visit, because a
// symptom they then volunteer has to be treated under that contract. Asking is
// what creates the obligation, so the guard has to be on the question, not on
// the answer.
//
// That makes the safe default obvious: `brief` unless we can PROVE the patient is
// on a private plan. Getting it wrong in one direction costs the practice a few
// questions it could have asked; getting it wrong in the other direction commits
// the practice to treatment it did not price. So:
//
//     fundingFromPlanId(planId) === "private"   ->  "full"
//     everything else                           ->  "brief"
//
// "Everything else" is four cases and every one of them lands on `brief` for its
// own reason, not by accident:
//
//   nhs      the case the rule exists for.
//   udc      the practice's urgent-dental-care plan (live id 47752, 37% of recent
//            registrations — more than Private). It is NHS urgent care. Treating
//            it as private because it is "not id 1" would be exactly the guess
//            this rule forbids.
//   unknown  a plan id outside this practice's live whitelist. We do not know what
//            it is, and a plan we cannot name is not a plan we may assume is
//            private. (fundingFromPlanId already refuses to round an unknown id
//            up to "private" for the diary's funding rail, for the same reason.)
//   null     no plan on file at all. Not evidence of anything.
//
// WHY THIS IS NOT A BOOLEAN `isPrivate`. Because the honest question is "which
// list do we send", and there are two lists. A boolean invites a caller to write
// `!isPrivate` somewhere and end up asking an unknown-plan patient about their
// pain because the negation read naturally.
//
// THE OUTPUT NEVER NAMES A FUNDING REGIME. See types.ts: `full`/`brief` are the
// stored, projected and rendered values, so no path from this decision to a
// patient's browser carries the word NHS or the word private. That is not
// belt-and-braces, it is the whole reason the union is spelled this way.
// ===========================================================================

/**
 * The bank a patient on this Dentally payment plan is asked.
 *
 * `planId` comes from `PatientRecord.paymentPlanId` (the flat `payment_plan_id`
 * and the nested `payment_plan.id`, resolved by the shared reader), which is a
 * PATIENT-level fact. An appointment payload carries no payment plan at all, so
 * the caller resolves the patient first — see the sweep.
 */
export function forkForPaymentPlan(planId: number | null | undefined): TriageFork {
  const code = fundingFromPlanId(typeof planId === "number" ? planId : null);
  return code === "private" ? "full" : "brief";
}

/**
 * Staff-facing words for a fork.
 *
 * NOT the funding word, even though this IS a staff screen and staff screens are
 * allowed to say NHS and private (the diary's funding rail does). Two reasons:
 *
 *   1. It would be a lie by rounding. `brief` is not "NHS" — it is also every UDC
 *      patient, every unknown plan and every patient with no plan on file. A
 *      column headed "NHS" over a row that is really "we could not resolve this
 *      patient's plan" is a worse fact than no column.
 *   2. This label is passed down component trees that also render patient-facing
 *      previews of the form. Keeping one vocabulary end to end is what makes the
 *      no-funding-words crawl in ./copy.test.ts a proof about the whole module
 *      rather than about a subset of its files.
 *
 * What a staff reader actually needs to know is which list the patient saw, and
 * that is what these say.
 */
export const FORK_LABEL: Record<TriageFork, string> = {
  full: "Full pre-visit questions",
  brief: "Shorter pre-visit questions",
};

/** One line of explanation for the staff screen, beside FORK_LABEL. */
export const FORK_NOTE: Record<TriageFork, string> = {
  full: "This patient was asked about their reason for coming, any discomfort, and what they would like to change.",
  brief:
    "This patient was asked to confirm their visit, whether anything about their health has changed, and what they would like to change. They were not asked about pain or symptoms.",
};
