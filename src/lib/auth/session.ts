import "server-only";
import { cache } from "react";
import { supabaseServer } from "@/lib/supabase/auth-server";
import { serviceClient } from "@/lib/supabase/server";
import { SITES, getSites } from "@/lib/mock/clients";
import type { Role } from "@/lib/types";

export interface AuthedUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** null for agency_admin (spans all clients). */
  clientId: string | null;
  /** Site ids this user may access (agency_admin: all sites; client users: their client's). */
  siteIds: string[];
}

interface AppUserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  client_id: string | null;
}

/**
 * The verified signed in user for this request, or null if not authenticated.
 *
 * Verifies the Supabase Auth session server-side (auth.getUser hits the auth
 * server, so a forged cookie does not pass), then resolves the user's role +
 * client from app_user. Site scope is derived here, never trusted from input.
 *
 * Wrapped in React cache(): a single /c/[client] render resolves the session up
 * to three times (root layout, guardPage, and the page body), each an auth-server
 * round-trip + a DB read. cache() collapses them to one per request (no cross-
 * request sharing — auth stays per-request correct).
 */
export const getSessionUser = cache(_getSessionUser);
async function _getSessionUser(): Promise<AuthedUser | null> {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const email = user?.email?.toLowerCase();
  if (!email) return null;

  const db = serviceClient();
  const { data, error } = await db
    .from("app_user")
    .select("id, email, name, role, client_id")
    .eq("email", email)
    .maybeSingle();
  if (error || !data) return null;

  const row = data as AppUserRow;
  const siteIds = row.client_id ? getSites(row.client_id).map((s) => s.id) : SITES.map((s) => s.id);
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    clientId: row.client_id,
    siteIds,
  };
}

/**
 * The verified email on the Auth session, regardless of whether an app_user
 * profile exists. Lets callers distinguish "signed in but unprovisioned" from
 * "not signed in" — the former is a confusing silent failure otherwise.
 */
export async function getAuthEmail(): Promise<string | null> {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.email?.toLowerCase() ?? null;
}

/** Whether this user may access the given client slug. */
export function canAccessClient(user: AuthedUser, clientId: string): boolean {
  return user.role === "agency_admin" || user.clientId === clientId;
}
