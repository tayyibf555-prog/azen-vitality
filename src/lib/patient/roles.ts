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
