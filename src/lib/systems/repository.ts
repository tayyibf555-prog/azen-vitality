import { serviceClient } from "@/lib/supabase/server";
import { isDryRun } from "@/lib/messaging/types";
import { SYSTEMS, SYSTEM_SLUGS } from "./catalog";

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
 * isSystemEnabled for a system that writes to a PATIENT RECORD: fail CLOSED,
 * always, whatever MESSAGING_DRY_RUN says.
 *
 * isSystemEnabledForSend below ties its fail direction to the messaging dry-run
 * flag, which is right for a Twilio send and wrong for a Dentally write: under
 * the staged configuration the owner actually runs (real writes, simulated
 * texts) a transient toggle-read error would re-arm a switch the owner had just
 * turned off, and the write would land in a real diary. A switch we cannot read
 * is treated as OFF here. A skipped move self-heals on the next click; a move
 * written against the owner's explicit instruction does not.
 */
export async function isSystemEnabledStrict(clientId: string, slug: string): Promise<boolean> {
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
    console.error(
      `[systems] isSystemEnabledStrict(${clientId}, ${slug}) failed; failing CLOSED (disabled)`,
      err,
    );
    return false;
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

// ---------------------------------------------------------------------------
// SEND-PATH variants — FAIL CLOSED once messaging is live.
//
// Once MESSAGING_DRY_RUN is off, the kill switch is the ONLY barrier between the
// 24/7 crons/webhooks and a real Twilio send. The fail-open default above is
// right for DISPLAY surfaces (a toggle-table blip must not blank the nav), but at
// a send choke point the same blip would silently re-arm every disabled system.
// So: while dry-run is on these behave exactly like the fail-open versions; once
// messaging is LIVE, a failed toggle read counts as DISABLED (skip the send —
// a skipped tick self-heals, a ghost send does not).
// ---------------------------------------------------------------------------

/** isSystemEnabled for send choke points: fail-open in dry-run, CLOSED when live. */
export async function isSystemEnabledForSend(clientId: string, slug: string): Promise<boolean> {
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
    const failOpen = isDryRun();
    console.error(
      `[systems] isSystemEnabledForSend(${clientId}, ${slug}) failed; ` +
        (failOpen ? "dry-run so defaulting to enabled" : "messaging is LIVE so failing CLOSED (disabled)"),
      err,
    );
    return failOpen;
  }
}

/**
 * getDisabledSlugs for the drain: fail-open in dry-run; when messaging is LIVE a
 * failed read returns EVERY slug as disabled, so the drain skips the whole tick.
 */
export async function getDisabledSlugsForSend(clientId: string): Promise<Set<string>> {
  try {
    const { data, error } = await serviceClient()
      .from(TABLE)
      .select("module_slug")
      .eq("client_id", clientId)
      .eq("enabled", false);
    if (error) throw error;
    return new Set((data ?? []).map((r) => String((r as { module_slug: string }).module_slug)));
  } catch (err) {
    const failOpen = isDryRun();
    console.error(
      `[systems] getDisabledSlugsForSend(${clientId}) failed; ` +
        (failOpen ? "dry-run so defaulting to none disabled" : "messaging is LIVE so failing CLOSED (all disabled)"),
      err,
    );
    return failOpen ? new Set() : new Set(SYSTEM_SLUGS);
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
