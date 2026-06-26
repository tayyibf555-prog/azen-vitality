// No-show cadence is APPOINTMENT-relative (unlike reactivation/recall, which are
// enrolment-relative): each step is due a fixed number of hours before the
// appointment. So it has its own small engine rather than reusing the shared one.

import type { TouchChannel } from "@/lib/reactivation/types";

export interface NoshowStep {
  step: number;                                 // 1-based
  channel: TouchChannel;
  hoursBefore: number;                          // hours before appointment start
  purpose: "confirm" | "reminder" | "final";
}

// T-48h confirmation request, T-24h reminder if still unconfirmed, T-3h final nudge.
export const NOSHOW_CADENCE: NoshowStep[] = [
  { step: 1, channel: "sms", hoursBefore: 48, purpose: "confirm" },
  { step: 2, channel: "sms", hoursBefore: 24, purpose: "reminder" },
  { step: 3, channel: "sms", hoursBefore: 3, purpose: "final" },
];

const HOUR = 3_600_000;

export function stepDef(step: number, def: NoshowStep[] = NOSHOW_CADENCE): NoshowStep | null {
  return def.find((s) => s.step === step) ?? null;
}

export function nextStep(currentStep: number, def: NoshowStep[] = NOSHOW_CADENCE): NoshowStep | null {
  return def.find((s) => s.step === currentStep + 1) ?? null;
}

/** ISO time a step is due: the appointment start minus the step's lead hours. */
export function dueAtForStep(step: NoshowStep, appointmentStart: Date): string {
  return new Date(appointmentStart.getTime() - step.hoursBefore * HOUR).toISOString();
}

/**
 * Where to start a fresh cadence for an appointment, skipping steps whose window
 * has already passed (so an appointment booked inside 48h is not blasted with
 * every reminder at once). Returns the step just before the first still-future
 * step, due at that step's time. If every window has passed (appointment is
 * imminent), send the final step now.
 */
export function enrolment(
  appointmentStart: Date,
  now: Date,
  def: NoshowStep[] = NOSHOW_CADENCE,
): { currentStep: number; nextDueAt: string } | null {
  for (const s of def) {
    const due = new Date(dueAtForStep(s, appointmentStart));
    if (due.getTime() >= now.getTime()) {
      return { currentStep: s.step - 1, nextDueAt: due.toISOString() };
    }
  }
  const last = def[def.length - 1];
  if (!last) return null;
  return { currentStep: last.step - 1, nextDueAt: now.toISOString() };
}

export interface NoshowAdvance {
  currentStep: number;
  status: "active" | "exhausted";
  nextDueAt: string | null;
  endedAt: string | null;
}

/**
 * Cadence position after `sentStep` has been sent. The next step is due at its
 * appointment-relative time, but never before `now` (so a late enrolment fires
 * remaining steps promptly rather than scheduling them in the past).
 */
export function advanceAfter(
  sentStep: number,
  appointmentStart: Date,
  now: Date,
  def: NoshowStep[] = NOSHOW_CADENCE,
): NoshowAdvance {
  const upcoming = nextStep(sentStep, def);
  if (upcoming) {
    const due = new Date(dueAtForStep(upcoming, appointmentStart)).getTime();
    const nextDueAt = new Date(Math.max(due, now.getTime())).toISOString();
    return { currentStep: sentStep, status: "active", nextDueAt, endedAt: null };
  }
  return { currentStep: sentStep, status: "exhausted", nextDueAt: null, endedAt: now.toISOString() };
}
