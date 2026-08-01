import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { FIELD_LABELS, type ProfileAuditRow, type ProfileField } from "./profile";
import type { DentallySyncResult } from "@/lib/patient-status/types";

/**
 * The audit trail for patient PROFILE edits.
 *
 * It shares the existing patient_admin_audit table (migration 0049) rather than adding
 * another, so one patient has ONE admin history: status changes and detail edits sit
 * side by side, newest first, on the index that is already there.
 *
 * Row mapping, using the columns for what they mean rather than adding any:
 *   action          'edit:<field>', e.g. 'edit:mobile_phone'  (status rows are 'set_status')
 *   from_status     the value BEFORE this edit, or null when the field was empty
 *   to_status       the value AFTER  this edit ('' when the field was cleared; NOT NULL)
 *   reason          the optional note the manager typed
 *   actor_email     who did it
 *   dentally_result 'synced' when Dentally accepted the write, 'failed' when it refused
 *
 * ONE ROW PER CHANGED FIELD, deliberately: a five-field edit reads as five legible
 * before/after lines, which is what makes the change defensible if a patient ever
 * disputes it. A row with dentally_result 'failed' records an ATTEMPTED edit that
 * Dentally rejected, so a refused change is never invisible; nothing changed on the
 * record in that case.
 *
 * Service-role only (RLS on, no anon/authenticated grants), like patient-status.
 */

/** Action prefix that distinguishes a profile-edit row from a status row. */
export const PROFILE_ACTION_PREFIX = "edit:";

export function profileAction(field: ProfileField): string {
  return `${PROFILE_ACTION_PREFIX}${field}`;
}

/** True for a profile-edit audit row (as opposed to a 'set_status' one). */
export function isProfileAction(action: string): boolean {
  return action.startsWith(PROFILE_ACTION_PREFIX);
}

export interface ProfileAuditEntry {
  id: string;
  field: string;
  /** Human label for the field, e.g. 'Mobile'. Falls back to the raw key. */
  label: string;
  from: string | null;
  to: string;
  reason: string | null;
  actorEmail: string | null;
  dentallyResult: DentallySyncResult | null;
  createdAt: string;
}

interface AuditRow {
  id: string;
  action: string;
  from_status: string | null;
  to_status: string;
  reason: string | null;
  actor_email: string | null;
  dentally_result: string | null;
  created_at: string;
}

const COLS = "id, action, from_status, to_status, reason, actor_email, dentally_result, created_at";

function toEntry(r: AuditRow): ProfileAuditEntry {
  const field = r.action.slice(PROFILE_ACTION_PREFIX.length);
  return {
    id: r.id,
    field,
    label: FIELD_LABELS[field as ProfileField] ?? field,
    from: r.from_status,
    to: r.to_status,
    reason: r.reason,
    actorEmail: r.actor_email,
    dentallyResult: (r.dentally_result as DentallySyncResult | null) ?? null,
    createdAt: r.created_at,
  };
}

/**
 * Append one audit row per changed field. THROWS on failure: the caller decides what to
 * do, and for a change that already reached Dentally it must at minimum log loudly and
 * tell the user the trail is incomplete. An edit to a real clinical record with no audit
 * trail is not acceptable, so this is never silently swallowed here.
 */
export async function insertProfileAudit(input: {
  siteId: string;
  patientId: string;
  rows: ProfileAuditRow[];
  reason: string | null;
  actorEmail: string | null;
  dentallyResult: DentallySyncResult;
}): Promise<void> {
  if (input.rows.length === 0) return;
  const db = serviceClient();
  const { error } = await db.from("patient_admin_audit").insert(
    input.rows.map((r) => ({
      site_id: input.siteId,
      dentally_patient_id: input.patientId,
      action: profileAction(r.field),
      from_status: r.from,
      to_status: r.to,
      reason: input.reason,
      actor_email: input.actorEmail,
      dentally_result: input.dentallyResult,
    })),
  );
  if (error) throw error;
}

/**
 * ONE chronological trail for one patient: profile edits AND status changes, merged,
 * newest first. This is what the record's Audit tab shows, because Dentally's Audit
 * tab is one trail rather than several.
 *
 * It is ADDITIVE. listProfileAudit below stays exactly as it is and keeps feeding the
 * profile editor's per-field history, and the status manager keeps its own filtered
 * status history. Both of those render things this merged view deliberately does not
 * (the editor's from/to/reason layout, the status manager's own filtering), and
 * neither may be lost.
 *
 * A row with dentallyResult 'failed' is an ATTEMPTED change Dentally refused: nothing
 * changed on the record, and that must stay legible rather than reading as a change
 * that happened.
 */
export interface PatientAuditEntry {
  id: string;
  /** 'edit' for a field change, 'status' for a status override. */
  kind: "edit" | "status";
  /** The field key for an edit row, null for a status row. */
  field: string | null;
  /** Human label: the field's label, or "Status" for a status row. */
  label: string;
  from: string | null;
  to: string;
  reason: string | null;
  actorEmail: string | null;
  dentallyResult: DentallySyncResult | null;
  createdAt: string;
}

export async function listPatientAudit(
  siteId: string,
  patientId: string,
  limit = 200,
): Promise<PatientAuditEntry[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("patient_admin_audit")
    .select(COLS)
    .eq("site_id", siteId)
    .eq("dentally_patient_id", patientId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as AuditRow[]).map((r) => {
    const isEdit = isProfileAction(r.action);
    const field = isEdit ? r.action.slice(PROFILE_ACTION_PREFIX.length) : null;
    return {
      id: r.id,
      kind: isEdit ? ("edit" as const) : ("status" as const),
      field,
      label: isEdit ? FIELD_LABELS[field as ProfileField] ?? (field as string) : "Status",
      from: r.from_status,
      to: r.to_status,
      reason: r.reason,
      actorEmail: r.actor_email,
      dentallyResult: (r.dentally_result as DentallySyncResult | null) ?? null,
      createdAt: r.created_at,
    };
  });
}

/** The most recent profile-edit entries for one patient, newest first. */
export async function listProfileAudit(
  siteId: string,
  patientId: string,
  limit = 20,
): Promise<ProfileAuditEntry[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("patient_admin_audit")
    .select(COLS)
    .eq("site_id", siteId)
    .eq("dentally_patient_id", patientId)
    .like("action", `${PROFILE_ACTION_PREFIX}%`)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as AuditRow[]).map(toEntry);
}
