import "server-only";
import { canAccessClient, getSessionUser, type AuthedUser } from "./session";
import { APPROVER_ROLES } from "@/lib/absence/rules";
import { isClinicalWriteRole } from "@/lib/patient/roles";
import { canRoleAccessModule } from "@/lib/nav";

/**
 * Auth + the database lock activate together: enforcement turns on once
 * SUPABASE_SERVICE_ROLE_KEY is set (which is also when migration 0012 locks the
 * DB to server-only). Until then, routes keep their existing pilot behaviour so
 * the running demo is not broken mid-build.
 */
export function authEnforced(): boolean {
  return Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/**
 * Gate an API route on a verified session.
 * - Not enforced: returns null (caller keeps its existing behaviour).
 * - Enforced + signed in: returns the user.
 * - Enforced + not signed in: returns a 401 Response (return it directly).
 */
export async function requireUser(): Promise<AuthedUser | Response | null> {
  if (!authEnforced()) return null;
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  return user;
}

/** 403 Response if an enforced user may not access this client; else null. */
export function requireClientAccess(user: AuthedUser | null, clientId: string): Response | null {
  if (user && !canAccessClient(user, clientId)) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  return null;
}

/**
 * 403 Response if an enforced user is not an owner-level role; else null.
 * Owner-only modules (AI generation, USPs) are restricted to the practice owner
 * and the agency admin. No-op when user is null, matching requireClientAccess.
 */
export function requireOwnerRole(user: AuthedUser | null): Response | null {
  if (user && user.role !== "client_owner" && user.role !== "agency_admin") {
    return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  return null;
}

/**
 * 403 Response if an enforced user is not an APPROVER-level role; else null.
 *
 * Additive, and deliberately NOT a change to `requireOwnerRole`: everything already
 * gated on that keeps its exact behaviour. The difference is one role. Approving
 * holiday is the practice manager's job, and in this platform the practice manager
 * is a `client_coordinator`, so `requireOwnerRole` would lock the feature's primary
 * user out of it. Widening the owner guard instead would silently hand her the
 * AI-generation and USP modules too, which is a different decision entirely.
 *
 * The role list lives in `@/lib/absence/rules` (where it is under test) so the HTTP
 * edge and the pure decision rules cannot drift apart. No-op when user is null,
 * matching requireClientAccess and requireOwnerRole.
 */
export function requireApproverRole(user: AuthedUser | null): Response | null {
  if (user && !APPROVER_ROLES.includes(user.role)) {
    return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  return null;
}

/**
 * 403 Response if an enforced user may not AUTHOR an entry in the clinical record;
 * else null.
 *
 * Additive, like `requireApproverRole`, and for the mirror-image reason. The routes
 * that write the chart draft, the perio charts and BPEs, the medical-history
 * questionnaires and reviews, and the retraction of any of them, previously ran on
 * `requireUser -> requireClientAccess -> requireSiteAccess` and therefore accepted
 * EVERY role attached to the practice. `requireApproverRole` would have been exactly
 * backwards here: it admits the coordinator and refuses the clinician, and the
 * clinician is the one person these routes exist for.
 *
 * The role list lives in `@/lib/patient/roles` (where it is under test, beside
 * PATIENT_ADMIN_ROLES) so the HTTP edge and the pure lists cannot drift apart, the
 * same arrangement `requireApproverRole` has with `@/lib/absence/rules`.
 *
 * No-op when user is null, matching every other guard in this file.
 */
export function requireClinicalWriteRole(user: AuthedUser | null): Response | null {
  if (user && !isClinicalWriteRole(user.role)) {
    return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  return null;
}

/**
 * THE API-LAYER COUNTERPART TO `requireModuleAccess` (page-guard.ts).
 *
 * The page guard was the ONLY thing consulting CLINICIAN_SLUGS. Nothing on the API
 * side did, and the three guards that exist there do not stand in for it:
 * `requireUser` proves only that somebody is signed in, `requireClientAccess`
 * admits every role attached to the client, and `requireSiteAccess` admits every
 * site on the user's own `siteIds` (which, for a clinician, is all of them). So a
 * clinician session hidden out of Conversations, Recall, Reactivation and the rest
 * at the page layer could still call those modules' routes directly — reading the
 * inbox, or texting any patient in the practice via POST /api/inbox/reply.
 *
 * `canRoleAccessModule` is allow-BY-DEFAULT for the original three roles (it returns
 * true for a slug carrying no `roles` array, and true for a slug it does not
 * recognise), and deny-by-default ONLY for `client_clinician`, whose branch runs
 * first and returns. That asymmetry is the whole point: this guard is a no-op for
 * agency_admin / client_owner / client_coordinator — it cannot take away anything
 * they have today — and is a real deny-list for the clinician. `module-api-guard.test.ts`
 * pins both halves of that claim.
 *
 * Null user = enforcement off, so it passes through exactly like requireClientAccess,
 * requireOwnerRole and requireApproverRole do, and the un-enforced pilot is unchanged.
 */
export function requireModuleApiAccess(user: AuthedUser | null, slug: string): Response | null {
  if (user && !canRoleAccessModule(user.role, slug)) {
    return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  return null;
}

/** 403 Response if an enforced user may not act on this site; else null. */
export function requireSiteAccess(user: AuthedUser | null, siteId: string): Response | null {
  if (user && !user.siteIds.includes(siteId)) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  return null;
}
