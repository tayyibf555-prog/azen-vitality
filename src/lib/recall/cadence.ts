// Recall reuses the reactivation cadence engine verbatim. Only the step
// definition differs, so we re-export the pure functions and supply RECALL_CADENCE.
// Every call site passes RECALL_CADENCE as the `def` argument.

import type { CadenceStep } from "@/lib/reactivation/cadence";

export { stepDef, nextStep, dueAt, advanceAfter, type CadenceStep } from "@/lib/reactivation/cadence";
export type { CadenceAdvance } from "@/lib/reactivation/cadence";

/**
 * Proactive recall cadence: an SMS nudge on/just-before the due date, an email
 * follow up five days later, then a final SMS a week after that. Friendly and
 * routine, not a chase.
 */
export const RECALL_CADENCE: CadenceStep[] = [
  { step: 1, channel: "sms", waitDays: 0, purpose: "nudge" },
  { step: 2, channel: "email", waitDays: 5, purpose: "offer" },
  { step: 3, channel: "sms", waitDays: 7, purpose: "final" },
];
