import "server-only";
import { requireUser, requireClientAccess, requireSiteAccess } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { getPatientById } from "@/lib/dentally/read";
import { getSite } from "@/lib/mock/clients";
import { isPatientAdminRole } from "./roles";

/**
 * The single guard chain for every patient-administration route (status, profile edit).
 * Extracted so the two routes cannot drift apart: one implementation, one set of rules.
 *
 *   requireUser -> role -> requireClientAccess -> requireSiteAccess -> patient/site IDOR
 *
 * The IDOR step is the one that is easy to miss and matches the getPatientDetail fix:
 * proving the caller may reach the NAMED site is not enough. The requested PATIENT must
 * actually belong to that site, or a caller holding site A could edit a site B patient by
 * pairing their own site with a foreign patient id. It fails closed with a 404 that never
 * reveals whether the patient exists.
 *
 * Returns either a Response to return immediately, or the resolved context.
 */
export async function requirePatientAdmin(
  patientId: string,
  siteId: string,
): Promise<Response | { auth: AuthedUser | null; siteId: string; clientId: string }> {
  const auth = await requireUser();
  if (auth instanceof Response) return auth;

  // Owners, practice managers (client_coordinator) and the agency admin only. No-op when
  // auth is null (enforcement off), matching the other guard helpers.
  if (auth && !isPatientAdminRole(auth.role)) {
    return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  if (!siteId) return Response.json({ ok: false, error: "siteId is required" }, { status: 400 });

  const clientId = getSite(siteId)?.clientId;
  if (!clientId) return Response.json({ ok: false, error: "unknown site" }, { status: 400 });

  const clientDenied = requireClientAccess(auth, clientId);
  if (clientDenied) return clientDenied;

  const siteDenied = requireSiteAccess(auth, siteId);
  if (siteDenied) return siteDenied;

  if (auth) {
    const patient = await getPatientById(patientId);
    if (!patient || patient.siteId !== siteId) {
      return Response.json({ ok: false, error: "not found" }, { status: 404 });
    }
  }

  return { auth, siteId, clientId };
}
