// Outstanding-balance collection agent: types + configuration. Pure, no I/O.
//
// WHAT THIS MODULE IS, AND THE ONE FACT THAT SHAPES ALL OF IT.
//
// Live Dentally exposes NO balance field on a treatment plan. The Treatment
// Coordinator's `amountOutstanding` is derived from `private_treatment_value` and
// means TREATMENT STILL TO BE DONE, not money owed (see the calibration block in
// src/app/api/sync/coordinator/route.ts, and the closer's own DEBT_PATTERNS,
// which refuse any wording that calls that figure a debt).
//
// So this module does NOT read treatment plans. The only thing in Dentally that
// represents money a patient actually owes is an UNPAID INVOICE, and that is the
// single source every figure and every claim here comes from. Nothing else.
//
// DRAFT FOR APPROVAL, ALWAYS AND ONLY.
//
// Unlike the treatment-plan closer, which ships approval-first and is intended to
// earn an auto-send mode later, this module has NO auto-send mode and no
// configuration that could grant one. Money plus patients is the one combination
// where a wrong message is not a tone problem, it is a false statement about
// somebody's finances made by a machine on the practice's letterhead. A person
// reads every message before it leaves. There is deliberately no flag below that
// could change that, and `collection-no-autosend.test.ts` proves no such path
// exists anywhere in the module.

import type { TouchChannel } from "@/lib/coordinator/types";

export type { TouchChannel };

/**
 * Lifecycle of one patient's balance conversation. Terminal: stopped, exhausted.
 * `awaiting_approval` and `in_flight` both mean "a touch is pending, do not draft
 * another"; they are separate so the worklist can tell a message waiting on a
 * human from one waiting on the drain.
 */
export type CollectionStateStatus =
  | "active"
  | "awaiting_approval"
  | "in_flight"
  | "stopped"
  | "exhausted";

/** Touch lifecycle. 'discarded' is the exit a human-rejected draft needs. */
export type CollectionTouchStatus =
  | "draft"
  | "approved"
  | "queued"
  | "sending"
  | "sent"
  | "failed"
  | "discarded";

/**
 * Why the agent stopped for good on a patient.
 *
 * Each is a FACT the module established, except `staff_stopped`, which is the one
 * a person supplies when they discard a draft saying "do not chase this patient".
 * Recording a near-synonym there would put a claim in the record nobody could
 * stand behind, exactly as the closer's own union avoids.
 *
 * `balance_cleared` is the happy exit and the most important one: the verification
 * read found no provable debt any more, so there is nothing to talk about.
 */
export type CollectionStopReason =
  | "balance_cleared"
  | "credit_on_account"
  | "patient_replied"
  | "dispute"
  | "hardship"
  | "confusion"
  | "opted_out"
  | "excluded"
  | "staff_stopped"
  | "exhausted"
  | "undeliverable"
  | "needs_a_person";

/**
 * Why a human has to look at this patient now.
 *
 * An escalation is not a log line, it is a work item: every one of these means the
 * machine has deliberately stopped and handed the conversation over. The agent
 * NEVER argues, never explains, never re-states the balance in reply to any of
 * them. See classifyCollectionReply, which fails SAFE: a reply it cannot place is
 * `unclear`, and `unclear` escalates.
 */
export type CollectionEscalationReason =
  | "dispute"
  | "hardship"
  | "confusion"
  | "unclear_reply"
  | "acknowledgement"
  | "opted_out"
  | "credit_on_account"
  | "balance_above_ceiling"
  | "unreadable_invoice";

export interface CollectionState {
  /** Dentally patient id. One conversation per patient, not per invoice. */
  patientId: string;
  siteId: string;
  status: CollectionStateStatus;
  /** Highest cadence step actually SENT. 0 means nothing has gone out yet. */
  step: number;
  stopReason: CollectionStopReason | null;
  escalatedAt: string | null;
  escalationReason: CollectionEscalationReason | null;
  firstQualifiedAt: string;
  lastTouchAt: string | null;
  lastDraftedAt: string | null;
  /** ISO. No draft may be created before this instant. */
  retryNotBefore: string | null;
  /** Consecutive failed deliveries (the provider could not deliver). */
  consecutiveFailures: number;
  /**
   * Consecutive BLOCKED sends, counted separately from failures on purpose.
   *
   * The shared drain calls markBlocked for four different things: an opt-out, the
   * output guardrail, an undeliverable address, and the cross-module once-per-day
   * frequency cap. Only the first three are anything wrong with the recipient; the
   * fourth is the platform's own politeness rule doing exactly its job. Folding
   * them into `consecutiveFailures` (which is what every other module does) means
   * a patient whose daily slot keeps going to a recall invite is eventually retired
   * as "undeliverable", which is a false statement about a perfectly reachable
   * person. So a block cools the conversation off without counting as a failure,
   * and has its own, higher ceiling so a genuinely stuck row cannot loop forever.
   */
  consecutiveBlocks: number;
  updatedAt: string;
}

export interface CollectionTouch {
  id: string;
  patientId: string;
  siteId: string;
  step: number;
  channel: TouchChannel;
  direction: "outbound" | "inbound";
  body: string;
  draftedBy: "claude" | "human";
  status: CollectionTouchStatus;
  /** Who acted on the draft: carries the approver AND the discarder. */
  approvedBy: string | null;
  /** Set only on a discarded touch: the reason the human gave. */
  discardReason: string | null;
  /**
   * Pence, snapshotted at the moment the draft was written, or null when the draft
   * quotes no figure at all. The approval route re-scans a human's edit against
   * THIS, not against a fresh read, so the human is held to the same figure the
   * model was given and an edit cannot smuggle in a different number.
   */
  amountPence: number | null;
  createdAt: string;
  sentAt: string | null;
}

export interface CollectionOutboxItem {
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
 * A deliberately small projection: the panel is a client component, so everything
 * here crosses to the browser. It carries what a human needs in order to judge the
 * message and nothing else. No Dentally patient id, no consent flags, no invoice
 * rows, no site id. Approve and discard requests carry `touchId` alone and the
 * server re-reads the rest from the stored row, so nothing here is trusted back.
 */
export interface CollectionDraftView {
  touchId: string;
  patientName: string;
  /** Pounds owed as the draft was written, or null when it quotes no figure. */
  amount: number | null;
  /** 1-based cadence position of this message. */
  step: number;
  channel: TouchChannel;
  /** The full message. Never truncated for the person approving it. */
  body: string;
  createdAt: string;
}

/** One step of the cadence. `waitDays` is the gap since the PREVIOUS SENT touch,
 *  or since qualification for step 1 (where it is 0). */
export interface CollectionStep {
  step: number;
  channel: TouchChannel;
  waitDays: number;
  /** What this step is FOR. Shapes the draft, never shown to the patient. */
  purpose: "notice" | "offer_help" | "close";
}

export interface CollectionConfig {
  /**
   * An invoice must be at least this old before it is chased. Measured from the
   * NEWEST unpaid invoice on the account, not the oldest: a patient who was billed
   * three days ago should not be chased about an older balance in the same breath,
   * because from where they sit the practice is chasing a bill they have barely
   * received. 21 days is the default, comfortably past a normal payment cycle.
   */
  minInvoiceAgeDays: number;
  /**
   * Below this the reminder is not worth sending. Not (only) an economics
   * judgement: a text about £4 reads as petty, damages the relationship the
   * practice depends on, and spends the patient's one outreach slot for the day.
   */
  minBalancePence: number;
  /**
   * Above this a person picks up the phone instead. A four-figure balance is a
   * conversation, not a text message, and it is also exactly the shape a units
   * mis-calibration would take (see COLLECTION_QUOTE_AMOUNT in draft.ts): if this
   * ceiling starts refusing most of the book, the money is being read in the wrong
   * unit and nothing should be sent until that is settled.
   */
  maxBalancePence: number;
  /**
   * How far the practice-wide snapshot and the per-patient verification read may
   * differ and still be treated as the same figure. ONE PENNY, and it exists for
   * exactly one reason: the shared debtors scan accumulates pounds as floating
   * point, so summing several invoices can land a hundredth of a penny out. It is
   * not slack for a payment that landed in between; any real movement is larger
   * than this and correctly refuses the draft.
   */
  snapshotTolerancePence: number;
  /** Hard cap on drafts created in a single sweep tick. */
  maxDraftsPerRun: number;
  /** Hard cap on debtors examined in a single sweep tick. */
  maxExaminedPerRun: number;
  /**
   * Hard cap on per-patient VERIFICATION reads in a single tick. Each one is a
   * live Dentally read against the practice's shared hourly quota, taken at
   * BACKGROUND priority, so it is bounded independently of the draft cap: a run
   * where every candidate fails verification must still cost a known number of
   * reads.
   */
  maxVerifyReadsPerRun: number;
  /** Cool-off after a compliance refusal, a discarded draft or a failed send. */
  cooldownHours: number;
  /** Consecutive failed deliveries after which the patient is retired. */
  maxConsecutiveFailures: number;
  /** Consecutive BLOCKED sends after which the patient is retired. Higher than the
   *  failure ceiling because most blocks are the daily frequency cap, which is the
   *  platform working correctly rather than anything being wrong. */
  maxConsecutiveBlocks: number;
}

export const DEFAULT_COLLECTION_CONFIG: CollectionConfig = {
  minInvoiceAgeDays: 21,
  minBalancePence: 2_500, // £25
  maxBalancePence: 1_000_000, // £10,000
  snapshotTolerancePence: 1,
  maxDraftsPerRun: 10,
  maxExaminedPerRun: 300,
  maxVerifyReadsPerRun: 40,
  cooldownHours: 24,
  maxConsecutiveFailures: 3,
  maxConsecutiveBlocks: 6,
};

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Read the config from the environment, falling back to the defaults. */
export function collectionConfig(): CollectionConfig {
  return {
    minInvoiceAgeDays: envNumber("COLLECTION_MIN_INVOICE_AGE_DAYS", DEFAULT_COLLECTION_CONFIG.minInvoiceAgeDays),
    minBalancePence: envNumber("COLLECTION_MIN_BALANCE_PENCE", DEFAULT_COLLECTION_CONFIG.minBalancePence),
    maxBalancePence: envNumber("COLLECTION_MAX_BALANCE_PENCE", DEFAULT_COLLECTION_CONFIG.maxBalancePence),
    snapshotTolerancePence: envNumber(
      "COLLECTION_SNAPSHOT_TOLERANCE_PENCE",
      DEFAULT_COLLECTION_CONFIG.snapshotTolerancePence,
    ),
    maxDraftsPerRun: envNumber("COLLECTION_MAX_DRAFTS_PER_RUN", DEFAULT_COLLECTION_CONFIG.maxDraftsPerRun),
    maxExaminedPerRun: envNumber("COLLECTION_MAX_EXAMINED_PER_RUN", DEFAULT_COLLECTION_CONFIG.maxExaminedPerRun),
    maxVerifyReadsPerRun: envNumber(
      "COLLECTION_MAX_VERIFY_READS_PER_RUN",
      DEFAULT_COLLECTION_CONFIG.maxVerifyReadsPerRun,
    ),
    cooldownHours: envNumber("COLLECTION_COOLDOWN_HOURS", DEFAULT_COLLECTION_CONFIG.cooldownHours),
    maxConsecutiveFailures: envNumber(
      "COLLECTION_MAX_CONSECUTIVE_FAILURES",
      DEFAULT_COLLECTION_CONFIG.maxConsecutiveFailures,
    ),
    maxConsecutiveBlocks: envNumber(
      "COLLECTION_MAX_CONSECUTIVE_BLOCKS",
      DEFAULT_COLLECTION_CONFIG.maxConsecutiveBlocks,
    ),
  };
}
