import "server-only";
import { getOverride, insertAudit, markOverrideSynced, upsertOverride } from "./repository";
import type { DentallySyncResult, PatientAdminStatus } from "./types";
import { dentallyAgentClient, isDentallyWriteEnabled } from "@/lib/dentally/write";
import { addAdminDoNotContact, clearAdminDoNotContact } from "@/lib/messaging/suppression";

// The orchestrator behind PATCH /api/patients/:id/status. Owns the precedence and the
// side-effect ordering so the route stays a thin guard layer.
//
// PRECEDENCE (documented once, here):
//   - The platform override is persisted FIRST and is the source of truth for targeting
//     and for the record chip. It ALWAYS takes effect immediately, regardless of what
//     Dentally does.
//   - Dentally's own `active` flag is synced ONLY for active/inactive and ONLY when the
//     write gate is on. do_not_contact has no Dentally equivalent, so it is never faked
//     upstream (result 'unsupported'). A sync failure never rolls back the override -
//     the platform truth stands and the audit records the honest Dentally outcome.
//   - Either signal excludes from targeting: the platform override OR Dentally's own
//     active=false (the existing prefilter). We never auto-clear an override from a
//     Dentally read; only an explicit status change here mutates it.

export interface ApplyStatusResult {
  status: PatientAdminStatus;
  dentally: DentallySyncResult;
  fromStatus: PatientAdminStatus | null;
}

function patientRef(patientId: string): string {
  return `patient:${patientId}`;
}

/**
 * Reflect an active/inactive change in Dentally. Returns:
 *   - 'unsupported' for do_not_contact (no Dentally field; never faked),
 *   - 'skipped' when writes are disabled (the default pilot posture),
 *   - 'synced' on a successful PUT /v1/patients/:id { active },
 *   - 'failed' when the write was attempted and errored (caught; override still applies).
 */
async function syncToDentally(patientId: string, status: PatientAdminStatus): Promise<DentallySyncResult> {
  if (status === "do_not_contact") return "unsupported";
  if (!isDentallyWriteEnabled()) return "skipped";
  try {
    const client = dentallyAgentClient();
    await client.updatePatient(patientId, { active: status === "active" });
    return "synced";
  } catch (err) {
    console.error(`[patient-status] Dentally updatePatient failed for ${patientId}; override still applied here`, err);
    return "failed";
  }
}

/**
 * Apply a status change end to end: read current -> persist override (platform truth,
 * immediate) -> sync suppression rows for do_not_contact -> attempt the Dentally write
 * -> mark synced if it landed -> write the audit trail. Never throws for a Dentally
 * failure; the override and suppression always apply.
 */
export async function applyStatusChange(input: {
  siteId: string;
  patientId: string;
  status: PatientAdminStatus;
  reason?: string | null;
  actorEmail?: string | null;
}): Promise<ApplyStatusResult> {
  const { siteId, patientId, status } = input;
  const reason = input.reason?.trim() ? input.reason.trim() : null;
  const actorEmail = input.actorEmail ?? null;

  // 1. Remember the prior status for the audit's from->to.
  const current = await getOverride(siteId, patientId);
  const fromStatus = current?.status ?? null;

  // 2. Persist the override FIRST - the platform truth applies immediately, before any
  //    remote call, so a slow/failed Dentally write never delays the platform effect.
  await upsertOverride({ siteId, patientId, status, reason, setBy: actorEmail });

  // 3. Suppression machinery for the send choke point (belt-and-braces). do_not_contact
  //    adds admin rows on every channel; any other status clears ONLY the admin rows and
  //    never a patient's own STOP.
  if (status === "do_not_contact") {
    await addAdminDoNotContact(siteId, patientRef(patientId));
  } else {
    await clearAdminDoNotContact(siteId, patientRef(patientId));
  }

  // 4. Attempt to reflect active/inactive in Dentally, and record whether it landed.
  const dentally = await syncToDentally(patientId, status);
  if (dentally === "synced") {
    await markOverrideSynced(siteId, patientId);
  }

  // 5. Audit trail (honest about the Dentally outcome).
  await insertAudit({
    siteId,
    patientId,
    action: "set_status",
    fromStatus,
    toStatus: status,
    reason,
    actorEmail,
    dentallyResult: dentally,
  });

  return { status, dentally, fromStatus };
}
