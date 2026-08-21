// Treatment-plan closer: types + configuration. Pure, no I/O.
//
// The closer is the approval-first follow-up on treatment a patient planned and
// never completed. It reads the Treatment Coordinator's own opportunity records
// (treatment_opportunity) and never talks to Dentally itself, so every figure it
// can possibly mention is one the practice already stored.

import type { TouchChannel } from "@/lib/coordinator/types";

export type { TouchChannel };

/**
 * Lifecycle of one opportunity inside the closer. Terminal: stopped, exhausted.
 * `awaiting_approval` and `in_flight` are both "a touch is pending, do not draft
 * another"; they are kept apart so a worklist can tell a message waiting on a
 * human from one waiting on the drain.
 */
export type CloserStateStatus =
  | "active"
  | "awaiting_approval"
  | "in_flight"
  | "stopped"
  | "exhausted";

/** Touch lifecycle. 'discarded' is the exit a human-rejected draft needs. */
export type CloserTouchStatus =
  | "draft"
  | "approved"
  | "queued"
  | "sending"
  | "sent"
  | "failed"
  | "discarded";

/**
 * Why the closer stopped for good on an opportunity.
 *
 * Every member except `staff_stopped` is a FACT the decider established for
 * itself. `staff_stopped` is the one a person supplies, when they discard a draft
 * saying "do not follow this patient up": no other member of this union is true in
 * that case, and recording the nearest one (`excluded`, `opted_out`) would put a
 * claim in the record that nobody could stand behind — that the patient's admin
 * status excludes them, or that the patient asked us to stop. See discard.ts.
 */
export type CloserStopReason =
  | "plan_completed"
  | "opportunity_closed"
  | "patient_replied"
  | "dispute"
  | "opted_out"
  | "excluded"
  | "staff_stopped"
  | "exhausted"
  | "undeliverable"
  | "too_old";

export interface CloserState {
  opportunityId: string;
  siteId: string;
  status: CloserStateStatus;
  /** Highest cadence step actually SENT. 0 means nothing has gone out yet. */
  step: number;
  stopReason: CloserStopReason | null;
  firstQualifiedAt: string;
  lastTouchAt: string | null;
  lastDraftedAt: string | null;
  /** ISO. No draft may be created before this instant. */
  retryNotBefore: string | null;
  /** Consecutive failed/blocked deliveries. Reset by a confirmed send. */
  consecutiveFailures: number;
  updatedAt: string;
}

export interface CloserTouch {
  id: string;
  opportunityId: string;
  siteId: string;
  step: number;
  channel: TouchChannel;
  direction: "outbound" | "inbound";
  body: string;
  draftedBy: "claude" | "human";
  status: CloserTouchStatus;
  /** Who acted on the draft. Carries the approver AND the discarder (migration 0087). */
  approvedBy: string | null;
  /** Set only on a discarded touch: the reason the human gave. */
  discardReason: string | null;
  createdAt: string;
  sentAt: string | null;
}

export interface CloserOutboxItem {
  id: string;
  touchId: string;
  siteId: string;
  channel: TouchChannel;
  toRef: string;
  body: string;
  status: "queued" | "sending" | "sent" | "delivered" | "failed";
  provider: string | null;
  createdAt: string;
  sentAt: string | null;
}

/**
 * One drafted message as the approval panel receives it.
 *
 * A PROJECTION, and a deliberately small one. The panel is a client component, so
 * everything here crosses to the browser: it carries what a human needs in order
 * to judge the message — who it is to, what it is about, the one figure, which
 * follow-up this is, and the message itself in full — and nothing else. No
 * Dentally patient id, no consent flags, no priority score, no site id. The
 * approve and discard requests carry `touchId` alone, and the server re-reads
 * everything else from the stored row, so nothing in this projection is trusted
 * back at the API.
 */
export interface CloserDraftView {
  touchId: string;
  opportunityId: string;
  patientName: string;
  treatment: string;
  /** GBP of treatment still to be done. NOT money owed. */
  amountOutstanding: number;
  /** 1-based cadence position of this message. */
  step: number;
  channel: TouchChannel;
  /** The full message. Never truncated for the person approving it. */
  body: string;
  createdAt: string;
}

/** One step of the closer cadence. `waitDays` is the gap since the PREVIOUS SENT
 *  touch, or since qualification for step 1 (where it is 0). */
export interface CloserStep {
  step: number;
  channel: TouchChannel;
  waitDays: number;
  /** What this step is FOR. Shapes the draft, never shown to the patient. */
  purpose: "open" | "options" | "close";
}

export interface CloserConfig {
  /**
   * A plan must be at least this old (since acceptedAt) before the closer will
   * touch it. Defaults to 21 days, which is strictly greater than the Treatment
   * Coordinator's own cadence span (COORDINATOR_CADENCE runs 0/3/7 days), so the
   * closer can never open a second conversation while the coordinator's nudge
   * sequence could still be running on the same opportunity.
   */
  minPlanAgeDays: number;
  /**
   * A plan older than this is not a live opportunity: the costing, the clinical
   * picture and the patient's circumstances have all moved on, so a follow-up
   * would be talking about something that no longer exists. Configurable, in the
   * same spirit as the reactivation window.
   */
  maxPlanAgeDays: number;
  /**
   * Remaining treatment value below which an opportunity is not worth a contact.
   * The drain enforces ONE outreach message per patient per day across every
   * module, so a patient contact is a genuinely scarce resource: spending one on
   * a small remainder costs a recall or a reactivation its slot that day.
   */
  minRemainingValue: number;
  /** Hard cap on drafts created in a single sweep tick. */
  maxDraftsPerRun: number;
  /** Hard cap on opportunities examined in a single sweep tick. */
  maxExaminedPerRun: number;
  /**
   * How long to wait before drafting again for the same opportunity after a
   * compliance refusal, a discarded draft, or a failed send. Without it a
   * systematically-refusing opportunity (a plan whose own treatment name trips a
   * rule, say) would burn AI budget on every tick.
   */
  cooldownHours: number;
  /**
   * Consecutive failed or blocked deliveries after which the opportunity is
   * retired as undeliverable. Without this the closer would inherit the
   * coordinator's behaviour of replaying the same step against a dead channel
   * indefinitely.
   */
  maxConsecutiveFailures: number;
}

export const DEFAULT_CLOSER_CONFIG: CloserConfig = {
  minPlanAgeDays: 21,
  maxPlanAgeDays: 365,
  minRemainingValue: 100,
  maxDraftsPerRun: 25,
  maxExaminedPerRun: 500,
  cooldownHours: 24,
  maxConsecutiveFailures: 3,
};

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Read the closer config from the environment, falling back to the defaults. */
export function closerConfig(): CloserConfig {
  return {
    minPlanAgeDays: envNumber("CLOSER_MIN_PLAN_AGE_DAYS", DEFAULT_CLOSER_CONFIG.minPlanAgeDays),
    maxPlanAgeDays: envNumber("CLOSER_MAX_PLAN_AGE_DAYS", DEFAULT_CLOSER_CONFIG.maxPlanAgeDays),
    minRemainingValue: envNumber("CLOSER_MIN_VALUE", DEFAULT_CLOSER_CONFIG.minRemainingValue),
    maxDraftsPerRun: envNumber("CLOSER_MAX_DRAFTS_PER_RUN", DEFAULT_CLOSER_CONFIG.maxDraftsPerRun),
    maxExaminedPerRun: envNumber("CLOSER_MAX_EXAMINED_PER_RUN", DEFAULT_CLOSER_CONFIG.maxExaminedPerRun),
    cooldownHours: envNumber("CLOSER_COOLDOWN_HOURS", DEFAULT_CLOSER_CONFIG.cooldownHours),
    maxConsecutiveFailures: envNumber(
      "CLOSER_MAX_CONSECUTIVE_FAILURES",
      DEFAULT_CLOSER_CONFIG.maxConsecutiveFailures,
    ),
  };
}
