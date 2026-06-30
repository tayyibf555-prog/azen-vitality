// Task Queue domain types. A "task" is one actionable item surfaced from an ops
// module. Candidate tasks are computed on read; only the overlay (done/snoozed/
// assigned) is persisted, keyed by a stable task_key.

export type TaskModule =
  | "speed-to-lead"
  | "recall"
  | "reactivation"
  | "coordinator"
  | "noshow"
  | "after-hours"
  | "smile-assessment"
  | "compliance";

export type TaskKind =
  | "contact_lead"
  | "chase_recall"
  | "reactivate"
  | "follow_up_plan"
  | "confirm_appt"
  | "after_hours_callback"
  | "action_assessment"
  | "compliance_audit"
  | "compliance_policy"
  | "compliance_training";

export type TaskStatus = "open" | "done" | "snoozed" | "dismissed";

export const TASK_KIND_LABEL: Record<TaskKind, string> = {
  contact_lead: "Contact lead",
  chase_recall: "Chase recall",
  reactivate: "Reactivate patient",
  follow_up_plan: "Follow up plan",
  confirm_appt: "Confirm appointment",
  after_hours_callback: "After-hours callback",
  action_assessment: "Review assessment",
  compliance_audit: "Compliance audit",
  compliance_policy: "Compliance policy",
  compliance_training: "Staff training",
};

/**
 * A computed actionable item, before the overlay is applied.
 *
 * Most tasks are patient/lead work, but compliance tasks (audits, policies,
 * training) carry no patient. For those, `patientName` holds the item name (it
 * is only used as the secondary sort key and the row label), so the field stays
 * a stable, non-empty string across every module.
 */
export interface CandidateTask {
  key: string; // stable: `<module>:<entityId>:<kind>`
  module: TaskModule;
  kind: TaskKind;
  title: string;
  subtitle: string | null;
  patientName: string;
  siteId: string;
  priority: number; // 0-100, higher first
  dueHint: string | null;
  href: string; // deep link to the owning module's worklist
}

/** The persisted overlay state for one task. */
export interface TaskOverlayState {
  taskKey: string;
  status: TaskStatus;
  assignee: string | null;
  snoozedUntil: string | null;
  note: string | null;
}

/** A candidate task with its effective overlay state applied. */
export interface Task extends CandidateTask {
  status: TaskStatus; // effective: an expired snooze resolves back to "open"
  assignee: string | null;
  snoozedUntil: string | null;
}
