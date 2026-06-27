import { serviceClient } from "@/lib/supabase/server";
import type { TaskOverlayState, TaskStatus } from "./types";

// Server-only CRUD for task_overlay: the persisted done/snoozed/assigned state for
// computed tasks, keyed by (client_id, task_key). Candidate tasks themselves are
// never stored (generate.ts computes them on read).

interface OverlayRow {
  task_key: string;
  status: string;
  assignee: string | null;
  snoozed_until: string | null;
  note: string | null;
}

function rowToOverlay(r: OverlayRow): TaskOverlayState {
  return {
    taskKey: r.task_key,
    status: r.status as TaskStatus,
    assignee: r.assignee,
    snoozedUntil: r.snoozed_until,
    note: r.note,
  };
}

/** All overlay rows for a client, keyed by task_key (for applyOverlay). */
export async function getOverlayMap(clientId: string): Promise<Map<string, TaskOverlayState>> {
  const db = serviceClient();
  const { data, error } = await db
    .from("task_overlay")
    .select("task_key, status, assignee, snoozed_until, note")
    .eq("client_id", clientId);
  if (error) throw error;
  const m = new Map<string, TaskOverlayState>();
  for (const row of (data as OverlayRow[]) ?? []) m.set(row.task_key, rowToOverlay(row));
  return m;
}

export interface OverlayPatch {
  status?: TaskStatus;
  assignee?: string | null;
  snoozedUntil?: string | null;
  note?: string | null;
}

/**
 * Merge a patch into the overlay for one task (read-modify-write so a snooze does
 * not wipe an assignee, etc.). Fields left undefined are preserved.
 */
export async function patchOverlay(
  clientId: string,
  taskKey: string,
  patch: OverlayPatch,
  updatedBy?: string | null,
): Promise<TaskOverlayState> {
  const db = serviceClient();
  const { data: existing, error: readErr } = await db
    .from("task_overlay")
    .select("*")
    .eq("client_id", clientId)
    .eq("task_key", taskKey)
    .maybeSingle();
  if (readErr) throw readErr;
  const prev = existing as OverlayRow | null;

  const merged = {
    client_id: clientId,
    task_key: taskKey,
    status: patch.status ?? prev?.status ?? "open",
    assignee: patch.assignee !== undefined ? patch.assignee : prev?.assignee ?? null,
    snoozed_until: patch.snoozedUntil !== undefined ? patch.snoozedUntil : prev?.snoozed_until ?? null,
    note: patch.note !== undefined ? patch.note : prev?.note ?? null,
    updated_by: updatedBy ?? null,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await db
    .from("task_overlay")
    .upsert(merged, { onConflict: "client_id,task_key" })
    .select("task_key, status, assignee, snoozed_until, note")
    .single();
  if (error) throw error;
  return rowToOverlay(data as OverlayRow);
}
