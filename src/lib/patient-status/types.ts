// Owner / practice-manager patient admin status (platform-side).
//
// This is the PLATFORM's own status for a patient, distinct from Dentally's `active`
// flag. The override is the source of truth for targeting and for the record chip;
// Dentally's flag is synced where the API supports it (active <-> inactive) and stays
// advisory for do_not_contact. See src/lib/patient-status/service.ts for precedence.

/** The three admin statuses a patient record can carry. */
export type PatientAdminStatus = "active" | "inactive" | "do_not_contact";

/** What happened when we tried to reflect the change in Dentally.
 *  - synced:      Dentally accepted the active/inactive write.
 *  - unsupported: do_not_contact has no Dentally equivalent (never faked upstream).
 *  - failed:      the write was attempted and errored (override still applies here).
 *  - skipped:     writes are disabled (default), so nothing was attempted. */
export type DentallySyncResult = "synced" | "unsupported" | "failed" | "skipped";

export interface PatientStatusOverride {
  siteId: string;
  patientId: string;
  status: PatientAdminStatus;
  reason: string | null;
  setBy: string | null;
  setAt: string;
  dentallySynced: boolean;
  dentallySyncedAt: string | null;
}

export interface PatientAdminAuditEntry {
  id: string;
  siteId: string;
  patientId: string;
  action: string;
  fromStatus: PatientAdminStatus | null;
  toStatus: PatientAdminStatus;
  reason: string | null;
  actorEmail: string | null;
  dentallyResult: DentallySyncResult | null;
  createdAt: string;
}

export const PATIENT_ADMIN_STATUSES: PatientAdminStatus[] = ["active", "inactive", "do_not_contact"];

export function isPatientAdminStatus(v: unknown): v is PatientAdminStatus {
  return v === "active" || v === "inactive" || v === "do_not_contact";
}

/**
 * Whether an override status EXCLUDES a patient from all outbound targeting and builds.
 * Both 'inactive' and 'do_not_contact' exclude; only 'active' is contactable. This is
 * the single definition every sweep and the outreach builder consult, so there is one
 * place to change the rule.
 */
export function excludesFromTargeting(status: PatientAdminStatus): boolean {
  return status === "inactive" || status === "do_not_contact";
}
