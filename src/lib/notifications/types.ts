// Notifications (alerts) domain types.
//
// A notification is a single thing the owner / team should act on now, DERIVED
// from existing module data (compliance, no-show risk, onboarding, enquiries).
// Like the Daily brief and Task queue, the feed is computed on read: there is no
// event store. Each item carries a STABLE id so a future dismiss overlay (and the
// optional localStorage hide in the UI) sticks to the right item across runs.

export type NotificationType =
  | "compliance"
  | "no_show"
  | "onboarding"
  | "lead"
  | "system";

export type NotificationUrgency = "high" | "medium" | "low";

export interface NotificationItem {
  /** Stable across runs, e.g. `compliance:<itemId>`, `no_show:<apptId>`, `lead:<id>`. */
  id: string;
  type: NotificationType;
  urgency: NotificationUrgency;
  title: string;
  detail: string;
  /** ISO instant the underlying thing happened / is anchored to (drives recency sort). */
  at: string;
  /** Where to go to act on it, e.g. `/c/<slug>/compliance`. Optional for system notes. */
  href?: string;
}
