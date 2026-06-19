import type { TouchChannel } from "./types";

export interface CadenceStep {
  step: number;                       // 1-based
  channel: TouchChannel;
  waitDays: number;                   // gap before this step (step 1 = 0)
  purpose: "nudge" | "offer" | "final";
}

export const DEFAULT_CADENCE: CadenceStep[] = [
  { step: 1, channel: "sms", waitDays: 0, purpose: "nudge" },
  { step: 2, channel: "email", waitDays: 5, purpose: "offer" },
  { step: 3, channel: "sms", waitDays: 7, purpose: "final" },
];

export function stepDef(step: number, def: CadenceStep[] = DEFAULT_CADENCE): CadenceStep | null {
  return def.find((s) => s.step === step) ?? null;
}

/** The next step to run given the last completed step. null = exhausted. */
export function nextStep(currentStep: number, def: CadenceStep[] = DEFAULT_CADENCE): CadenceStep | null {
  return def.find((s) => s.step === currentStep + 1) ?? null;
}

/** ISO due time for a step, anchored to `from` (previous send time or enrolment). */
export function dueAt(step: CadenceStep, from: Date): string {
  return new Date(from.getTime() + step.waitDays * 86_400_000).toISOString();
}

export interface CadenceAdvance {
  currentStep: number;
  status: "active" | "exhausted";
  nextDueAt: string | null;
  endedAt: string | null;
}

/** Cadence position after `sentStep` has been sent at `now`. */
export function advanceAfter(
  sentStep: number,
  now: Date,
  def: CadenceStep[] = DEFAULT_CADENCE,
): CadenceAdvance {
  const upcoming = nextStep(sentStep, def);
  if (upcoming) {
    return { currentStep: sentStep, status: "active", nextDueAt: dueAt(upcoming, now), endedAt: null };
  }
  return { currentStep: sentStep, status: "exhausted", nextDueAt: null, endedAt: now.toISOString() };
}
