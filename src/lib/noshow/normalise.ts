// Pure no-show classification: turn an upcoming appointment + patient history
// into a defended target with a risk score. No I/O, fully unit-tested.

import type { NoshowTarget, RiskBand } from "./types";

export interface NoshowConfig {
  leadDays: number;            // defend appointments within this many days (default 14)
}
export const DEFAULT_CONFIG: NoshowConfig = { leadDays: 14 };

export interface AppointmentInfo {
  id: string;
  start: string;               // ISO
  state: string;
  durationMin: number;
  practitioner: string | null;
}

export interface NoshowInput {
  siteId: string;
  dentallyPatientId: string;
  patientName: string;
  appointment: AppointmentInfo;
  priorAppointments: number;   // count of past appointments (any state)
  priorNoShows: number;        // count of past did_not_attend
  isNewPatient: boolean;       // no completed visits on record
  bookedDaysAhead: number;     // lead time: days between booking and the appointment
  consent: { sms: boolean; email: boolean; marketing: boolean };
  now: Date;
}

const DAY = 86_400_000;

/** 0-100 no-show risk. History dominates; new patients and odd lead times add. */
export function riskScore(input: NoshowInput): number {
  let score = 0;
  if (input.priorAppointments > 0) {
    const rate = input.priorNoShows / input.priorAppointments; // 0..1
    score += rate * 60;                                        // up to 60 from history
  }
  if (input.isNewPatient) score += 25;                         // no track record
  if (input.bookedDaysAhead <= 2) score += 15;                 // very last-minute
  else if (input.bookedDaysAhead >= 30) score += 10;           // booked long ago, easy to forget
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function bandFor(score: number): RiskBand {
  if (score >= 60) return "high";
  if (score >= 30) return "medium";
  return "low";
}

/**
 * Build a defended target, or null if the appointment is not a candidate
 * (malformed/past start, outside the lead window, or already terminal).
 */
export function toNoshowTarget(
  input: NoshowInput,
  cfg: NoshowConfig = DEFAULT_CONFIG,
): NoshowTarget | null {
  const start = new Date(input.appointment.start);
  if (Number.isNaN(start.getTime())) return null;             // malformed: fail-safe skip
  const ms = start.getTime() - input.now.getTime();
  if (ms <= 0) return null;                                    // already started / past
  if (ms > cfg.leadDays * DAY) return null;                   // too far out to defend yet

  const st = input.appointment.state.toLowerCase();
  if (st === "cancelled" || st === "did_not_attend" || st === "completed") return null;

  const score = riskScore(input);
  return {
    id: `${input.siteId}:${input.dentallyPatientId}:${input.appointment.id}`,
    siteId: input.siteId,
    dentallyPatientId: input.dentallyPatientId,
    appointmentId: input.appointment.id,
    patientName: input.patientName,
    appointmentStartAt: start.toISOString(),
    appointmentState: input.appointment.state,
    durationMin: input.appointment.durationMin,
    practitioner: input.appointment.practitioner,
    riskScore: score,
    riskBand: bandFor(score),
    status: "scheduled",
    priorAttempts: 0,
    consent: input.consent,
    updatedFromDentallyAt: input.now.toISOString(),
  };
}

/** Highest risk first, then soonest appointment. */
export function rankByRisk(targets: NoshowTarget[]): NoshowTarget[] {
  return [...targets].sort(
    (a, b) =>
      b.riskScore - a.riskScore ||
      new Date(a.appointmentStartAt).getTime() - new Date(b.appointmentStartAt).getTime(),
  );
}
