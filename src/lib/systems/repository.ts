import { serviceClient } from "@/lib/supabase/server";
import { SYSTEMS } from "./catalog";

// Persistence for the per-system kill switch (table system_toggle, migration 0034).
//
// DEFAULT-ON: the absence of a row means the system is enabled. A row exists only
// once an owner has explicitly toggled a system. So a fresh deployment (or a
// deployment where the migration has not run yet) behaves exactly as before —
// everything enabled — which is the whole point of shipping this dormant.
//
// FAIL-OPEN on read: if the toggle read errors, treat the system as ENABLED. This
// keeps default-ON honest (a missing table or a transient blip must not silently
// halt a system) and is safe in practice: when the DB is unreachable the sweeps
// and the drain have nothing to act on anyway (their own reads fail the same way).
// The switch is authoritative whenever the DB is reachable, which is exactly when
// sends can happen.

const TABLE = "system_toggle";

/**
 * Is one system enabled for a client? True unless a row explicitly disables it.
 * Never throws: a read error resolves to enabled (see FAIL-OPEN above).
 */
export async function isSystemEnabled(clientId: string, slug: string): Promise<boolean> {
  try {
    const { data, error } = await serviceClient()
      .from(TABLE)
      .select("enabled")
      .eq("client_id", clientId)
      .eq("module_slug", slug)
      .maybeSingle();
    if (error) throw error;
    return data ? Boolean(data.enabled) : true; // no row => enabled
  } catch (err) {
    console.error(`[systems] isSystemEnabled(${clientId}, ${slug}) failed; defaulting to enabled`, err);
    return true;
  }
}

/**
 * The set of DISABLED system slugs for a client, in one query. Used by the drain
 * (and any batch consumer) so it can skip disabled systems without a read per
 * source. Never throws: on error returns an empty set (all enabled).
 */
export async function getDisabledSlugs(clientId: string): Promise<Set<string>> {
  try {
    const { data, error } = await serviceClient()
      .from(TABLE)
      .select("module_slug")
      .eq("client_id", clientId)
      .eq("enabled", false);
    if (error) throw error;
    return new Set((data ?? []).map((r) => String((r as { module_slug: string }).module_slug)));
  } catch (err) {
    console.error(`[systems] getDisabledSlugs(${clientId}) failed; defaulting to none disabled`, err);
    return new Set();
  }
}

/**
 * Every controllable system's current state for a client, merged over the catalog
 * so the panel always renders the full list (missing rows -> enabled=true). Unlike
 * the read helpers this DOES propagate an error, so the owner panel can show a
 * clear failure rather than a falsely all-on grid.
 */
export async function getSystemStates(
  clientId: string,
): Promise<Array<{ slug: string; enabled: boolean; updatedAt: string | null; updatedBy: string | null }>> {
  const { data, error } = await serviceClient()
    .from(TABLE)
    .select("module_slug, enabled, updated_at, updated_by")
    .eq("client_id", clientId);
  if (error) throw error;
  const bySlug = new Map(
    (data ?? []).map((r) => {
      const row = r as { module_slug: string; enabled: boolean; updated_at: string | null; updated_by: string | null };
      return [row.module_slug, row];
    }),
  );
  return SYSTEMS.map((s) => {
    const row = bySlug.get(s.slug);
    return {
      slug: s.slug,
      enabled: row ? Boolean(row.enabled) : true,
      updatedAt: row?.updated_at ?? null,
      updatedBy: row?.updated_by ?? null,
    };
  });
}

/** Set (upsert) one system's enabled state for a client. Propagates write errors. */
export async function setSystemEnabled(
  clientId: string,
  slug: string,
  enabled: boolean,
  updatedBy: string | null,
): Promise<void> {
  const { error } = await serviceClient()
    .from(TABLE)
    .upsert(
      {
        client_id: clientId,
        module_slug: slug,
        enabled,
        updated_by: updatedBy,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "client_id,module_slug" },
    );
  if (error) throw error;
}
