import "server-only";
import { cache } from "react";
import { serviceClient } from "@/lib/supabase/server";
import type { AuthedUser } from "@/lib/auth/session";
import type { Role } from "@/lib/types";
import { type Capability } from "./keys";
import { ROLE_DEFAULTS, safeDefaults } from "./defaults";
import { resolveCapabilities, type CapabilityOverride } from "./resolve";

// ===========================================================================
// THE OVERRIDE OVERLAY (table user_capability, migration 0072).
//
// A row is an EXPLICIT decision about one person and one capability. No row
// means "ask the role", which is what makes the whole feature inert until an
// owner ticks something.
//
// WHY THIS IS NOT PART OF getSessionUser. `getSessionUser` already costs one
// auth-server round trip plus one app_user read on EVERY request — the root
// layout, the sidebar, the telemetry beacon, and the ninety-odd routes that will
// never ask about a capability. Folding an overlay read into it puts a third hop
// on all of them. So this is its own `cache()`d resolver: same per-request
// memoisation, and zero cost on a request that never asks. A route checking
// three capabilities does one read.
//
// `cache()` keys on ARGUMENT IDENTITY. `getSessionUser` is itself `cache()`d and
// returns the same object reference throughout a request, so passing it here
// memoises correctly. Do NOT call this with a freshly constructed user object.
// ===========================================================================

const TABLE = "user_capability";

export interface StoredOverride {
  appUserId: string;
  capability: string;
  granted: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

/**
 * The capabilities this signed-in user actually holds.
 *
 * FAILS CLOSED ON A READ ERROR, and this is the one behaviour in this file worth
 * arguing about. An unreadable overlay is not proof of a grant — it is proof
 * that we do not know. So a failed read returns the role's NON-DESTRUCTIVE
 * defaults: everything readable still reads, every write stops, and the reason
 * is on the server log. The alternative (fall back to the full role defaults)
 * would mean a transient database blip silently restores a permission an owner
 * had explicitly revoked, which is the exact failure this table exists to prevent.
 */
export const getCapabilities = cache(_getCapabilities);

async function _getCapabilities(user: AuthedUser): Promise<ReadonlySet<Capability>> {
  // agency_admin has a null client_id (0011_app_user.sql), and the composite
  // tenant FK in 0072 means a null can never satisfy it — so no override row for
  // them can exist. Short-circuit rather than issue a query that must return zero
  // rows. The platform administrator is not something a practice may edit.
  if (!user.clientId) return ROLE_DEFAULTS[user.role];

  try {
    const { data, error } = await serviceClient()
      .from(TABLE)
      .select("capability, granted")
      .eq("client_id", user.clientId)
      .eq("app_user_id", user.id);
    if (error) throw error;
    const overrides: CapabilityOverride[] = (data ?? []).map((r) => {
      const row = r as { capability: string; granted: boolean };
      return { capability: String(row.capability), granted: Boolean(row.granted) };
    });
    return resolveCapabilities(user.role, overrides);
  } catch (err) {
    console.error(
      `[capabilities] overlay read failed for ${user.id} (${user.clientId}); ` +
        `failing CLOSED to the role's non-destructive defaults`,
      err,
    );
    return safeDefaults(user.role);
  }
}

/**
 * Every override row for one practice, for the admin grid.
 *
 * PROPAGATES its error, unlike the guard above. The grid must never render a
 * confident empty state over an unreadable table: "nobody has any overrides" and
 * "we could not read the overrides" look identical and mean opposite things.
 */
export async function listOverrides(clientId: string): Promise<StoredOverride[]> {
  const { data, error } = await serviceClient()
    .from(TABLE)
    .select("app_user_id, capability, granted, updated_at, updated_by")
    .eq("client_id", clientId);
  if (error) throw error;
  return (data ?? []).map((r) => {
    const row = r as {
      app_user_id: string;
      capability: string;
      granted: boolean;
      updated_at: string | null;
      updated_by: string | null;
    };
    return {
      appUserId: String(row.app_user_id),
      capability: String(row.capability),
      granted: Boolean(row.granted),
      updatedAt: row.updated_at ?? null,
      updatedBy: row.updated_by ?? null,
    };
  });
}

export interface ClientPerson {
  id: string;
  name: string;
  email: string;
  role: Role;
}

/**
 * The logins that belong to one practice — the ROWS of the grid.
 *
 * Scoped by client_id at the query, so an agency admin viewing a practice sees
 * that practice's people and not every login on the platform. agency_admin rows
 * carry a null client_id and are therefore absent by construction, which is
 * correct: they are not a practice's to administer.
 */
export async function listClientPeople(clientId: string): Promise<ClientPerson[]> {
  const { data, error } = await serviceClient()
    .from("app_user")
    .select("id, name, email, role")
    .eq("client_id", clientId)
    .order("name");
  if (error) throw error;
  return (data ?? []).map((r) => {
    const row = r as { id: string; name: string; email: string; role: Role };
    return { id: String(row.id), name: String(row.name), email: String(row.email), role: row.role };
  });
}

/** One person's role + identity, for the admin rules. Null when they are not of this practice. */
export async function getClientPerson(clientId: string, appUserId: string): Promise<ClientPerson | null> {
  const { data, error } = await serviceClient()
    .from("app_user")
    .select("id, name, email, role")
    .eq("client_id", clientId)
    .eq("id", appUserId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as { id: string; name: string; email: string; role: Role };
  return { id: String(row.id), name: String(row.name), email: String(row.email), role: row.role };
}

/**
 * Write one explicit decision. Upserts on the primary key, so ticking a box twice
 * is idempotent and the audit fields move to the latest decider.
 *
 * EVERY toggle writes a row, including one that agrees with the role default.
 * "Only store the diffs" would be smaller and would lose the fact that a human
 * looked at this and decided — which, for a practice that has to answer a CQC
 * inspector's "who let her retract that record", is the part that matters.
 */
export async function setOverride(
  clientId: string,
  appUserId: string,
  capability: string,
  granted: boolean,
  updatedBy: string | null,
): Promise<void> {
  const { error } = await serviceClient()
    .from(TABLE)
    .upsert(
      {
        client_id: clientId,
        app_user_id: appUserId,
        capability,
        granted,
        updated_by: updatedBy,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "client_id,app_user_id,capability" },
    );
  if (error) throw error;
}

/** Reset to the role default = delete the row. Absence of a row IS the default. */
export async function clearOverride(
  clientId: string,
  appUserId: string,
  capability: string,
): Promise<void> {
  const { error } = await serviceClient()
    .from(TABLE)
    .delete()
    .eq("client_id", clientId)
    .eq("app_user_id", appUserId)
    .eq("capability", capability);
  if (error) throw error;
}
