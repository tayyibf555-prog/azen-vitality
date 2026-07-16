import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import type { FeedbackItem, FeedbackSeverity, NewFeedbackItem } from "./types";

interface Row {
  id: string;
  client_id: string;
  user_id: string | null;
  user_email: string | null;
  role: string | null;
  page_path: string;
  note: string;
  severity: string;
  status: string;
  created_at: string;
}

const COLS = "id, client_id, user_id, user_email, role, page_path, note, severity, status, created_at";

function toItem(r: Row): FeedbackItem {
  return {
    id: r.id,
    clientId: r.client_id,
    userId: r.user_id,
    userEmail: r.user_email,
    role: r.role,
    pagePath: r.page_path,
    note: r.note,
    severity: r.severity as FeedbackSeverity,
    status: r.status,
    createdAt: r.created_at,
  };
}

/** Save one feedback report. */
export async function insertFeedback(input: NewFeedbackItem): Promise<FeedbackItem> {
  const db = serviceClient();
  const { data, error } = await db
    .from("feedback_item")
    .insert({
      client_id: input.clientId,
      user_id: input.userId,
      user_email: input.userEmail,
      role: input.role,
      page_path: input.pagePath,
      note: input.note,
      severity: input.severity,
    })
    .select(COLS)
    .single();
  if (error) throw error;
  return toItem(data as Row);
}

/** Every feedback report across every client, newest first (the agency console list). */
export async function listFeedback(): Promise<FeedbackItem[]> {
  const db = serviceClient();
  const { data, error } = await db.from("feedback_item").select(COLS).order("created_at", { ascending: false });
  if (error) throw error;
  return (data as Row[]).map(toItem);
}

/** Update a report's status (e.g. mark done). */
export async function setFeedbackStatus(id: string, status: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("feedback_item").update({ status }).eq("id", id);
  if (error) throw error;
}
