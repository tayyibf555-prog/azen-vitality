// The Treatment Coordinator reuses the reactivation cadence engine verbatim. Only
// the step definition differs, so we re-export the pure functions and supply
// COORDINATOR_CADENCE. Every call site passes COORDINATOR_CADENCE as the `def`
// argument.

import type { CadenceStep } from "@/lib/reactivation/cadence";

export { stepDef, nextStep, dueAt, advanceAfter, type CadenceStep } from "@/lib/reactivation/cadence";
export type { CadenceAdvance } from "@/lib/reactivation/cadence";

/**
 * Treatment coordinator cadence: an SMS nudge straight away, an email with the
 * offer to discuss finance three days later, then a final SMS a week after that.
 * Warm and helpful, not a chase.
 */
export const COORDINATOR_CADENCE: CadenceStep[] = [
  { step: 1, channel: "sms", waitDays: 0, purpose: "nudge" },
  { step: 2, channel: "email", waitDays: 3, purpose: "offer" },
  { step: 3, channel: "sms", waitDays: 7, purpose: "final" },
];
