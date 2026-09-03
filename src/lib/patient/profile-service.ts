import "server-only";
import { dentallyAgentClient } from "@/lib/dentally/write";
import { dentallyWrite, precheckDentallyWrite } from "@/lib/dentally/write-gate";
import { applyStatusChange } from "@/lib/patient-status/service";
import { invalidateFundingCache } from "@/lib/calendar/funding-source";
import { insertProfileAudit } from "./profile-audit";
import {
  buildAuditRows,
  buildUpdatePayload,
  canonicaliseProfile,
  detectConflicts,
  diffProfile,
  type PatientProfile,
  type ProfileChanges,
  type ProfileField,
} from "./profile";

/**
 * The orchestrator behind GET / PATCH /api/patients/:id/profile. The route stays a thin
 * guard layer; the ordering and the safety decisions live here.
 *
 * This is the FIRST feature in the platform that edits an existing real patient record,
 * so the posture is deliberately conservative:
 *
 *   1. THE WRITE GATE COMES FIRST. Without isDentallyWriteEnabled() nothing is read and
 *      nothing is sent; the caller is told plainly that patient editing is switched off.
 *   2. THE RECORD IS RE-READ FROM DENTALLY on every save, through the SAME client the
 *      write will use, so the diff is against the record as it really stands, never
 *      against whatever a page loaded minutes ago.
 *   3. ONLY CHANGED FIELDS ARE SENT. An edit of one field cannot silently rewrite the
 *      other twelve.
 *   4. CONCURRENT EDITS: the caller posts the snapshot its form was loaded with. If a
 *      field it is CHANGING has moved underneath it, the save is refused with the list of
 *      collided fields so the manager re-reads before overwriting a colleague. Two people
 *      editing DIFFERENT fields of the same patient do not block each other.
 *   5. THE ACTIVE FLAG IS DELEGATED to the existing patient-status service rather than
 *      being PUT here. That keeps the platform override, the messaging suppression rows,
 *      Dentally's own flag and the status audit in lockstep, instead of creating a second
 *      source of truth for the same switch.
 */

export type ProfileWriteResult = "synced" | "failed";

export interface ApplyProfileSuccess {
  ok: true;
  /** The fields that genuinely changed. Empty when the save was a no-op. */
  changed: ProfileField[];
  /** The record as it stands after the edit. */
  profile: PatientProfile;
  /** False when the Dentally write landed but the audit insert did not (logged loudly). */
  auditRecorded: boolean;
}

export interface ApplyProfileFailure {
  ok: false;
  code: "write_disabled" | "not_found" | "conflict" | "dentally_failed";
  message: string;
  /** Only for 'conflict': the fields that moved underneath the caller. */
  conflicts?: ProfileField[];
}

export type ApplyProfileOutcome = ApplyProfileSuccess | ApplyProfileFailure;

/** Plain, non-technical wording for a manager staring at a form that will not save. */
const OFF_MESSAGE =
  "Patient editing is switched off. Changes to a patient record are not being sent to Dentally at the moment.";

/** Read the patient straight from Dentally and canonicalise. null when unreadable. */
async function readCurrent(patientId: string): Promise<PatientProfile | null> {
  const client = dentallyAgentClient();
  try {
    const res = await client.getPatient(patientId);
    const p = res.patient;
    if (!p || typeof p !== "object") return null;
    return canonicaliseProfile(p as Record<string, unknown>);
  } catch (err) {
    console.error(`[patient-profile] getPatient(${patientId}) failed`, err);
    return null;
  }
}

/**
 * The patient's current editable values, for painting the edit form. Readable whether or
 * not the write gate is open - viewing what is on file is not a write.
 */
export async function getProfile(patientId: string): Promise<PatientProfile | null> {
  return readCurrent(patientId);
}

export async function applyProfileEdit(input: {
  siteId: string;
  patientId: string;
  /** Whitelisted, already validated and canonicalised (parseProfileChanges). */
  changes: ProfileChanges;
  /** The snapshot the caller's form was loaded with, for the concurrency check. */
  expected: PatientProfile;
  reason?: string | null;
  /** For the profile AUDIT, which is a staff-facing record and names the person. */
  actorEmail?: string | null;
  /**
   * The OPAQUE user id, for the Dentally sync ledger.
   *
   * A separate field from actorEmail on purpose. The audit trail is the
   * practice's own record of who changed a patient's details and has to name a
   * person; the sync ledger is a technical record of what was sent to Dentally
   * and holds no personal data at all, staff included. One field used for both
   * would have put a work email in the second.
   */
  actorId?: string | null;
}): Promise<ApplyProfileOutcome> {
  const { siteId, patientId, changes, expected } = input;
  const reason = input.reason?.trim() ? input.reason.trim() : null;
  const actorEmail = input.actorEmail ?? null;
  const actorId = input.actorId ?? null;

  // 1. The gate, before anything else. Never POST when it is shut.
  //
  // ASKED THROUGH THE GATE, so a manager's refused save is recorded as an
  // attempt rather than vanishing into a message. Still before the Dentally
  // re-read below, so a refused save costs no quota, and the wording the manager
  // sees is unchanged.
  const refused = await precheckDentallyWrite({
    ctx: { source: "patient-admin", siteId, actor: actorId, patientId },
    kind: "patient.update",
  });
  if (refused) {
    return { ok: false, code: "write_disabled", message: OFF_MESSAGE };
  }

  // 2. Re-read the record as it stands right now.
  const current = await readCurrent(patientId);
  if (!current) {
    return { ok: false, code: "not_found", message: "That patient record could not be read from Dentally." };
  }

  // 3. Concurrency, checked only on the fields being changed.
  const requested = Object.keys(changes) as ProfileField[];
  const conflicts = detectConflicts(expected, current, requested);
  if (conflicts.length > 0) {
    return {
      ok: false,
      code: "conflict",
      conflicts,
      message: "This record changed while you were editing it. Close and reopen the patient, then try again.",
    };
  }

  // 4. Only what actually moved.
  const changed = diffProfile(current, changes);
  if (changed.length === 0) {
    return { ok: true, changed: [], profile: current, auditRecorded: true };
  }

  // 5. The detail fields go FIRST, in ONE whitelisted PUT rebuilt from the diff.
  //
  //    Order matters. The active flag is delegated below and has side effects well beyond
  //    Dentally (the platform override, the suppression rows, the lifecycle exclusions),
  //    so it is applied only once the ordinary PUT has actually landed. Doing it the other
  //    way round would leave a patient switched inactive while the caller is truthfully
  //    told the save failed.
  const payload = buildUpdatePayload(changes, changed);
  const rows = buildAuditRows(current, changes, changed);
  let result: ProfileWriteResult = "synced";
  if (Object.keys(payload).length > 0) {
    try {
      await dentallyWrite.updatePatient(
        { source: "patient-admin", siteId, actor: actorId },
        patientId,
        payload,
      );
    } catch (err) {
      console.error(`[patient-profile] updatePatient failed for ${patientId}`, err);
      result = "failed";
    }
  }

  // 5b. The diary's funding cache holds a patient's plan for five minutes, so a
  //     patient switched between plans here would keep the old rail and the old
  //     word on the diary until it aged out. Dropped as soon as the write lands.
  if (result === "synced" && changed.includes("payment_plan_id")) {
    invalidateFundingCache(patientId);
  }

  // 6. The audit trail, including a refused write (recorded as an attempt, so a rejected
  //    edit is never invisible). Best-effort ONLY in the sense that a failed insert
  //    cannot roll back a write Dentally already accepted: it is logged loudly and
  //    reported to the caller rather than swallowed.
  let auditRecorded = true;
  try {
    await insertProfileAudit({ siteId, patientId, rows, reason, actorEmail, dentallyResult: result });
  } catch (err) {
    auditRecorded = false;
    console.error(
      `[patient-profile] AUDIT INSERT FAILED for ${patientId} after a ${result} write of ${changed.join(", ")}`,
      err,
    );
  }

  if (result === "failed") {
    // Nothing was applied: the PUT was refused and the active delegation has not run.
    return {
      ok: false,
      code: "dentally_failed",
      message: "Dentally refused that change, so nothing was saved. Check the details and try again.",
    };
  }

  // 7. Only now the active flag, through the status service, so the platform override, the
  //    messaging suppression rows and Dentally's own flag stay in lockstep (it writes its
  //    own audit entry). It never throws; it reports the Dentally outcome instead.
  if (changed.includes("active")) {
    await applyStatusChange({
      siteId,
      patientId,
      status: changes.active ? "active" : "inactive",
      reason,
      actorEmail,
    });
  }

  // 8. Report the record as it now stands, so the form repaints from the truth.
  return { ok: true, changed, profile: { ...current, ...changes }, auditRecorded };
}
