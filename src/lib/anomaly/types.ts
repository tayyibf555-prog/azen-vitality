// ---------------------------------------------------------------------------
// Proactive anomaly alerts: the domain types.
//
// This is NOT a chatbot and it is not a new agent. It is an alerting layer over
// figures the platform ALREADY computes — the dashboard's takings strip, the
// no-show risk book, the speed-to-lead worklist, the approval queues and the
// shared outbox. Nothing here reads Dentally directly, nothing here drafts a
// word to a patient, and nothing here sends anything.
//
// THE ONE RULE THE WHOLE MODULE IS BUILT AROUND.
//
// An alert must never assert a number the underlying read could not prove. The
// dashboard's own house rule is that a figure it cannot source is `null` with a
// plain-English reason, never a plausible-looking zero — and this module inherits
// that verbatim by consuming the dashboard's own `TakingsCell`s rather than
// re-totalling anything. A truncated payment scan produces a null cell, a null
// cell produces no alert, and so "takings are down 40%" can never be said about a
// scan that simply did not reach back far enough.
//
// Every detector in detect.ts therefore has exactly two ways to be silent, and
// they are deliberately different:
//   REFUSAL   the reading is missing, partial or unprovable -> say nothing.
//   QUIET     the reading is sound and nothing is wrong -> say nothing.
// A quiet day and a broken pipe look identical to the owner, which is the
// correct trade: a false alarm about money costs more than a missed one.
// ---------------------------------------------------------------------------

/** How loudly an alert asks for attention. Mirrors NotificationUrgency. */
export type AlertSeverity = "high" | "medium" | "low";

/**
 * The conditions this module can detect. Adding one means adding a detector, a
 * threshold test either side of the line, and a row in the migration's CHECK
 * constraint — the constraint is what stops a typo becoming a silent no-op.
 */
export type AlertKind =
  | "takings_trend"
  | "noshow_cluster"
  | "lead_sla"
  | "approval_backlog"
  | "outbox_stuck"
  | "send_failures";

/** Every kind, for the migration's CHECK constraint and the coverage tests. */
export const ALERT_KINDS: readonly AlertKind[] = [
  "takings_trend",
  "noshow_cluster",
  "lead_sla",
  "approval_backlog",
  "outbox_stuck",
  "send_failures",
] as const;

/**
 * One thing worth a human's attention.
 *
 * `sentence` is the whole of the message: one plain-English sentence (or two) a
 * practice owner understands without knowing what a cadence or an outbox is. It
 * is deliberately not a title + detail pair, because the failure mode of that
 * shape is a title that overstates and a detail nobody reads.
 */
export interface Alert {
  kind: AlertKind;
  severity: AlertSeverity;
  /**
   * The stable identity of the CONDITION, not of this observation. Two runs that
   * see the same problem produce the same key, which is what stops a persistent
   * condition pinging the owner every day. Deliberately carries no timestamp
   * unless the condition genuinely renews (see `noshow_cluster`, which is keyed
   * by diary day because tomorrow's diary is a new problem, not the same one).
   */
  dedupeKey: string;
  /** The one sentence the owner reads. Plain British English, no jargon. */
  sentence: string;
  /**
   * Module-relative path to the screen that shows the evidence, e.g.
   * "no-show-defence". The delivery layer prefixes `/c/<clientSlug>/`, exactly
   * as the daily brief's own BriefLine.href does, so the detector stays pure and
   * knows nothing about which practice it is running for.
   *
   * NULL when no screen in the platform shows this evidence yet. Three modules
   * are in that position (the closer's queue renders inside Treatment
   * Coordinator, but balance reminders and post-op check-ins are headless
   * systems whose worklists are a later workstream). An alert about them is
   * still worth raising — the owner needs to know a queue is backing up whether
   * or not there is a page to click — so the link is dropped rather than the
   * alert, and the delivery layer renders it without one.
   */
  href: string | null;
  /** ISO instant the condition is anchored to (drives recency sort on the feed). */
  at: string;
}

// ---------------------------------------------------------------------------
// Thresholds. Every one of these is exported so a test can sit a fixture either
// side of the line rather than hard-coding a number the implementation could
// drift away from.
// ---------------------------------------------------------------------------

/** Takings: the proportional fall in daily takings that counts as "material". */
export const TAKINGS_DROP_FRACTION = 0.25;
/** Takings: and the fall must also be worth this much in real money, in pence. */
export const TAKINGS_DROP_MIN_PENCE = 25_000; // £250
/** Takings: at or beyond this fall, the alert is high rather than medium. */
export const TAKINGS_DROP_HIGH_FRACTION = 0.4;

/** No-show: high-risk appointments in today+tomorrow before it is a cluster. */
export const NOSHOW_CLUSTER_MIN = 4;
/** No-show: at or beyond this many, the cluster is high rather than medium. */
export const NOSHOW_CLUSTER_HIGH = 8;

/**
 * Speed-to-lead: how long an enquiry may sit uncontacted before a human should
 * know. The automated sweep's own SLA is 30 SECONDS (SLA_MS in
 * src/app/api/speed-to-lead/sweep/route.ts); this is not that number and must
 * not be. Thirty seconds is when the machine should have acted; an hour is when
 * its silence has become a person's problem.
 */
export const LEAD_SLA_MINUTES = 60;

/** Approvals: drafts waiting on a human before the queue counts as backing up. */
export const APPROVAL_BACKLOG_MIN = 10;
/** Approvals: or a single draft waiting this long, however small the queue. */
export const APPROVAL_STALE_HOURS = 72;

/** Outbox: a queued message older than this is not "waiting", it is stuck. */
export const OUTBOX_STUCK_HOURS = 6;
/** Outbox: how many stuck messages make it the owner's problem rather than the drain's. */
export const OUTBOX_STUCK_MIN = 3;

/** Sends: failures in the last day before "it failed" becomes "it is failing". */
export const SEND_FAILURE_MIN = 5;
/** Sends: the window those failures are counted over. */
export const SEND_FAILURE_WINDOW_HOURS = 24;

/**
 * Once a condition has cleared, how long before the same key may raise again.
 * Without this a flapping condition (a queue that crosses the line each evening
 * and clears each morning) would ping daily, which is the exact noise the dedupe
 * key exists to prevent.
 */
export const RERAISE_COOLDOWN_HOURS = 24;
