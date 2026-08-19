// Pure Task Queue logic: priority scoring + applying the persisted overlay to the
// computed candidates. No I/O, fully unit-tested.

import type { CandidateTask, Task, TaskKind, TaskOverlayState, TaskStatus } from "./types";

/** Base urgency by task kind (higher is worked first). */
export const KIND_BASE: Record<TaskKind, number> = {
  // The top of the queue, and deliberately AT THE CAP rather than merely near it.
  // A real person is mid-conversation, has been told a colleague will come back to
  // them, and is waiting right now; nothing else in this queue has someone holding
  // their phone. A base of 92 was not enough: `confirm_appt` starts at 90 and a
  // maximum risk score adds 10, so the single most urgent thing in the practice was
  // ranked below an appointment reminder. At 100 (which is also the ceiling every
  // other kind's boost is clamped to) an escalation can be equalled by a
  // maximum-boost task but never beaten, and a tie falls through to the existing
  // name ordering.
  agent_escalation: 100,
  confirm_appt: 90, // a high-risk appointment today/tomorrow
  contact_lead: 82, // a fresh enquiry, speed matters most
  after_hours_callback: 80, // someone tried to reach the practice out of hours
  action_assessment: 74, // a high-intent quiz lead not yet picked up
  // A medium-band enquiry: warm, uncontacted, and worth a human's judgement, but
  // below the high scorers and below anything with a clock on it. Sits between the
  // acquisition work above and the compliance desk work below.
  review_enquiry: 66,
  // Compliance: a base that sits below the time-critical patient work, then an
  // overdue boost (passed as overdueDays) lifts a breached item near the top.
  // due_soon items pass no boost and stay in the medium band.
  compliance_audit: 68, // an overdue regulatory audit (HTM 01-05, fire, etc.)
  compliance_policy: 64, // a missing / review-due required policy
  compliance_training: 60, // overdue / expiring mandatory staff training
  follow_up_plan: 62, // money on the table, but not time-critical
  // A medical-history review is a legal obligation before treatment, but it is a
  // desk task, not time-critical to the minute; it sits with the clinical-admin band.
  review_medical_history: 58,
  reactivate: 54,
  chase_recall: 48,
};

export interface UrgencyInput {
  /** Days past the due date (recall / reactivation). */
  overdueDays?: number;
  /** No-show risk 0-100. */
  riskScore?: number;
  /** GBP recoverable / outstanding (coordinator / reactivation). */
  recoverableValue?: number;
}

/**
 * Priority 0-100 for a task: a base by kind plus a bounded urgency boost. Kept
 * deliberately simple and monotonic so it is easy to reason about and test.
 */
export function computePriority(kind: TaskKind, u: UrgencyInput = {}): number {
  let p = KIND_BASE[kind] ?? 50;
  if (u.riskScore != null) p += Math.min(10, Math.max(0, u.riskScore) / 10);
  if (u.overdueDays != null && u.overdueDays > 0) p += Math.min(8, u.overdueDays / 7);
  if (u.recoverableValue != null && u.recoverableValue > 0) p += Math.min(8, u.recoverableValue / 500);
  return Math.round(Math.min(100, p));
}

/**
 * Apply the overlay to the candidates:
 *  - no overlay row  -> open
 *  - done / dismissed -> hidden
 *  - snoozed and still within snoozedUntil -> hidden
 *  - snoozed but expired -> resurfaces as a fresh open task
 * Then sort by priority (desc), breaking ties by patient name for stability.
 */
export function applyOverlay(
  candidates: CandidateTask[],
  overlays: Map<string, TaskOverlayState>,
  nowIso: string,
): Task[] {
  const now = Date.parse(nowIso);
  const out: Task[] = [];
  for (const c of candidates) {
    const o = overlays.get(c.key);
    if (!o) {
      out.push({ ...c, status: "open", assignee: null, snoozedUntil: null });
      continue;
    }
    // done / dismissed is TERMINAL for this task_key: a stable key
    // (`<module>:<entityId>:<kind>`) that is resolved stays hidden even if the same
    // entity becomes actionable again. That is intended for these one-shot worklists
    // (a contacted/converted lead does not re-surface); a recurring task would need a
    // freshness discriminator in its key. Snooze (below) is the only non-terminal hide.
    if (o.status === "done" || o.status === "dismissed") continue;
    if (o.status === "snoozed") {
      const until = o.snoozedUntil ? Date.parse(o.snoozedUntil) : 0;
      if (until > now) continue; // still snoozed -> hide
      // expired -> resurface as a clean open task
      out.push({ ...c, status: "open", assignee: o.assignee, snoozedUntil: null });
      continue;
    }
    // status === "open" (e.g. just claimed/assigned)
    const status: TaskStatus = "open";
    out.push({ ...c, status, assignee: o.assignee, snoozedUntil: o.snoozedUntil });
  }
  return sortTasks(out);
}

export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort(
    (a, b) => b.priority - a.priority || a.patientName.localeCompare(b.patientName),
  );
}
