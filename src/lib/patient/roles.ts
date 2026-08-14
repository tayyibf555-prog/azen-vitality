import type { Role } from "@/lib/types";

/**
 * Who may administer a patient record: change their status, or edit their details.
 *
 * PURE and framework-free on purpose, so the server guard and the client components that
 * hide the controls read from the SAME list. A drifted copy is how a role gate quietly
 * stops matching what the UI shows.
 *
 * The list, and why:
 *   - client_owner        the practice owners (Jawad, Murtaza). Their own records.
 *   - client_coordinator  how the PRACTICE MANAGER is represented in this platform
 *                         today (there is no separate manager role). This is the role
 *                         the client asked to be able to edit patients.
 *   - agency_admin        the platform administrator, who spans every client.
 *
 * Anything below that gets a 403 from the server and no edit controls in the UI. The
 * server gate is the real enforcement; hiding the controls is only courtesy.
 */
export const PATIENT_ADMIN_ROLES: readonly string[] = ["client_owner", "client_coordinator", "agency_admin"];

const ROLE_SET: ReadonlySet<string> = new Set(PATIENT_ADMIN_ROLES);

/** True when this role may administer a patient record. */
export function isPatientAdminRole(role: string | null | undefined): boolean {
  return typeof role === "string" && ROLE_SET.has(role);
}

/**
 * Who may WRITE a clinical record: the chart draft, a perio chart or BPE, a
 * medical-history questionnaire or review, and the retraction of any of those.
 *
 * A DIFFERENT LIST FROM PATIENT_ADMIN_ROLES, and the difference is the point.
 * Administering a patient (changing their status, correcting a phone number) is
 * front-desk work, and the practice manager does it every day. Recording a
 * periodontal finding, charting a tooth or signing off a medical history is a
 * CLINICAL act: it becomes part of the patient's clinical record, it is attributed
 * to whoever made it (GDC 4.1.4), and it is not the receptionist's or the
 * coordinator's to make. So this list swaps `client_coordinator` for
 * `client_clinician` and keeps the two accountable roles above them.
 *
 * `client_staff` appears in NEITHER list, which is the fifth role's whole design:
 * a nurse or receptionist login reaches no part of the patient record at all.
 *
 * Read + write are deliberately not the same gate. The coordinator can still READ
 * a chart or a medical history (they book around it and they answer the phone about
 * it); what they lose is the ability to author one. The read side stays governed by
 * the module gate on "patients".
 */
export const CLINICAL_WRITE_ROLES: readonly Role[] = [
  "agency_admin",
  "client_owner",
  "client_clinician",
] as const;

const CLINICAL_WRITE_SET: ReadonlySet<string> = new Set<string>(CLINICAL_WRITE_ROLES);

/** True when this role may author (or retract) an entry in the clinical record. */
export function isClinicalWriteRole(role: string | null | undefined): boolean {
  return typeof role === "string" && CLINICAL_WRITE_SET.has(role);
}
