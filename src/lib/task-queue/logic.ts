// Pure Task Queue logic: priority scoring + applying the persisted overlay to the
// computed candidates. No I/O, fully unit-tested.

import type { CandidateTask, Task, TaskKind, TaskOverlayState, TaskStatus } from "./types";

/** Base urgency by task kind (higher is worked first). */
export const KIND_BASE: Record<TaskKind, number> = {
  confirm_appt: 90, // a high-risk appointment today/tomorrow
  contact_lead: 82, // a fresh enquiry, speed matters most
  after_hours_callback: 80, // someone tried to reach the practice out of hours
  action_assessment: 74, // a high-intent quiz lead not yet picked up
  follow_up_plan: 62, // money on the table, but not time-critical
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
