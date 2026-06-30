import "server-only";
import { canAccessClient, getSessionUser, type AuthedUser } from "./session";

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

/** 403 Response if an enforced user may not act on this site; else null. */
export function requireSiteAccess(user: AuthedUser | null, siteId: string): Response | null {
  if (user && !user.siteIds.includes(siteId)) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  return null;
}
