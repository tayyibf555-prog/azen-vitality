// In-app feedback domain types (migration 0043_feedback_item.sql).

export type FeedbackSeverity = "bug" | "idea" | "question";

export const FEEDBACK_SEVERITIES: FeedbackSeverity[] = ["bug", "idea", "question"];

export interface FeedbackItem {
  id: string;
  clientId: string;
  userId: string | null;
  userEmail: string | null;
  role: string | null;
  pagePath: string;
  note: string;
  severity: FeedbackSeverity;
  status: string;
  createdAt: string;
}

export interface NewFeedbackItem {
  clientId: string;
  userId: string | null;
  userEmail: string | null;
  role: string | null;
  pagePath: string;
  note: string;
  severity: FeedbackSeverity;
}
