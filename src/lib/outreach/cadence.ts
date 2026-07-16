// Outreach reuses the reactivation cadence engine verbatim (like recall). Only the
// step definition differs, so we re-export the pure functions and supply
// OUTREACH_CADENCE. Every call site passes OUTREACH_CADENCE as the `def` argument.

import type { CadenceStep } from "@/lib/reactivation/cadence";

export { stepDef, nextStep, dueAt, advanceAfter, type CadenceStep } from "@/lib/reactivation/cadence";
export type { CadenceAdvance } from "@/lib/reactivation/cadence";

/**
 * Outreach cadence: three friendly SMS invites over ~10 days, landing on days 0, 3
 * and 9 (waitDays are the GAPS between steps: 0, then +3, then +6). SMS-only on
 * purpose, the whole campaign is about texting a cohort into a specific clinician's
 * diary, so there is no email step and consent is a single SMS check. Warm and
 * light, never a chase.
 */
export const OUTREACH_CADENCE: CadenceStep[] = [
  { step: 1, channel: "sms", waitDays: 0, purpose: "nudge" },
  { step: 2, channel: "sms", waitDays: 3, purpose: "offer" },
  { step: 3, channel: "sms", waitDays: 6, purpose: "final" },
];
