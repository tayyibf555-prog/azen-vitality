import "server-only";

// ===========================================================================
// THE DIARY'S GUARD CHAIN.
//
// Two levels, because reading the diary and changing it are different acts:
//   requireDiaryRead   any signed-in user with access to the site.
//   requireDiaryAdmin  the patient-admin roles only, plus a practitioner/site
//                      check when a practitioner is named.
//
// Gated on PATIENT_ADMIN_ROLES and NEVER on requireOwnerRole. client_coordinator
// IS how the practice manager is represented in this platform, and she is the
// diary's primary user and the person PRODUCT.md names as the gatekeeper. Gating
// the diary on owner-only would lock out the one person who lives in it.
// ===========================================================================

import { requireUser, requireClientAccess, requireSiteAccess } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { getSite } from "@/lib/mock/clients";
import { isPatientAdminRole } from "@/lib/patient/roles";
import { listSitePractitionersSafe } from "@/lib/dentally/read";

export interface DiaryAccess {
  auth: AuthedUser | null;
  siteId: string;
  clientId: string;
}

/** Any signed-in user holding this site may READ its diary. */
export async function requireDiaryRead(siteId: string): Promise<Response | DiaryAccess> {
  const auth = await requireUser();
  if (auth instanceof Response) return auth;

  if (!siteId) return Response.json({ ok: false, error: "siteId is required" }, { status: 400 });

  const clientId = getSite(siteId)?.clientId;
  if (!clientId) return Response.json({ ok: false, error: "unknown site" }, { status: 400 });

  const clientDenied = requireClientAccess(auth, clientId);
  if (clientDenied) return clientDenied;

  const siteDenied = requireSiteAccess(auth, siteId);
  if (siteDenied) return siteDenied;

  return { auth, siteId, clientId };
}

/**
 * The guard for every diary WRITE (breaks, notes, and the appointment move).
 *
 * Shaped exactly like requirePatientAdmin so the two cannot drift:
 *   requireUser -> role -> requireClientAccess -> requireSiteAccess -> practitioner/site
 *
 * The last step is the one that is easy to miss. Proving the caller may reach the
 * NAMED site is not enough: availability takes no site parameter, so the
 * practitioner id set is the ONLY thing scoping any of this to a site. A caller
 * holding site A could otherwise attach a break, or move an appointment, onto a
 * site B clinician's column by pairing their own site with a foreign practitioner
 * id. It fails closed with a 404 that reveals nothing about whether the
 * practitioner exists.
 */
export async function requireDiaryAdmin(
  siteId: string,
  practitionerId?: string | null,
): Promise<Response | DiaryAccess> {
  const auth = await requireUser();
  if (auth instanceof Response) return auth;

  // No-op when auth is null (enforcement off), matching the other guard helpers.
  // The appointment-move route deliberately does NOT inherit that permissiveness:
  // it checks authEnforced() itself and fails closed.
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

  if (practitionerId) {
    const read = await listSitePractitionersSafe(siteId);
    // A FAILED practitioner read is not proof of anything, so it cannot be treated
    // as proof the practitioner belongs here. Refuse rather than guess.
    if (read.failed) {
      return Response.json(
        { ok: false, error: "We could not check the clinician list for this site. Nothing has been changed." },
        { status: 503 },
      );
    }
    if (!read.practitioners.some((p) => p.id === practitionerId)) {
      return Response.json({ ok: false, error: "not found" }, { status: 404 });
    }
  }

  return { auth, siteId, clientId };
}
