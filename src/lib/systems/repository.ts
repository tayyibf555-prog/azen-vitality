import { serviceClient } from "@/lib/supabase/server";
import { isDryRun } from "@/lib/messaging/types";
import { DEFAULT_OFF_SLUGS, SYSTEMS, SYSTEM_SLUGS, defaultEnabledFor } from "./catalog";

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
//
// THE ONE EXCEPTION, and why it exists. A system may declare
// `defaultEnabled: false` in the catalog, which inverts BOTH rules above for that
// slug alone: no row means disabled, and a failed read means disabled. That is
// what a brand new outbound surface needs, because "nobody has ever opened the
// control panel" and "the toggle table is briefly unreadable" must not be the
// reasons a patient receives the first message from a system nobody switched on.
// Seeding a disabled row cannot deliver this on its own: a seed covers only the
// clients and the databases it was applied to, while defaultEnabledFor covers
// every client and every environment, including one where the migration has not
// run. Today exactly one slug uses it ('treatment-closer'); for every other slug
// defaultEnabledFor returns true and the behaviour is unchanged, byte for byte.

const TABLE = "system_toggle";

interface ToggleRow {
  module_slug: string;
  enabled: boolean;
}

/**
 * The DISABLED set for one client, given its toggle rows: every slug explicitly
 * set to false, plus every default-off slug the client has NOT explicitly
 * enabled. Written once and shared by both getDisabledSlugs variants so the
 * display path and the send path can never disagree about what is off.
 */
function disabledSetFrom(rows: ToggleRow[] | null | undefined): Set<string> {
  const explicit = new Map<string, boolean>();
  for (const r of rows ?? []) explicit.set(String(r.module_slug), Boolean(r.enabled));
  const disabled = new Set<string>();
  for (const [slug, enabled] of explicit) if (!enabled) disabled.add(slug);
  for (const slug of DEFAULT_OFF_SLUGS) if (explicit.get(slug) !== true) disabled.add(slug);
  return disabled;
}

// ---------------------------------------------------------------------------
// DEDUPE for getDisabledSlugs' fail-open log line.
//
// getDisabledSlugs is called once per navigation by every DISPLAY surface that
// renders the "N issues" panel. In local dev (noauth config, no service-role
// key) every single call fails the same way, so the console fills with 100+
// copies of the identical line and buries whatever error actually matters.
//
// Fix: log the FIRST occurrence of a given (clientId, reason) pair loudly,
// then stay quiet for exact repeats. A DIFFERENT reason for the same client
// (or the same reason for a different client) is a materially different fact
// and must still log — a naive dedupe keyed on clientId alone would swallow a
// brand-new fault (e.g. a permissions error appearing after a table-missing
// error had already been seen) which is worse than the noise this fixes.
//
// The key is derived from the error's own code/message, not from the raw
// error object, so it stays small and stable. loggedDisabledSlugsFailures is
// a module-level Set that lives for the process lifetime (this runs on a
// long-lived server) — capped at MAX_TRACKED_FAILURES and cleared wholesale
// if it somehow grows past that, so a pathological stream of distinct error
// shapes cannot leak memory. Clearing just re-arms logging for reasons
// already seen, which is safe: fail-open logging noise, never behaviour, is
// the only thing that dedupe controls.
// ---------------------------------------------------------------------------

const MAX_TRACKED_DISABLED_SLUGS_FAILURES = 500;
const loggedDisabledSlugsFailures = new Set<string>();

function disabledSlugsFailureReason(err: unknown): string {
  const anyErr = err as { code?: unknown; message?: unknown } | null | undefined;
  if (anyErr && typeof anyErr.code === "string" && anyErr.code) return anyErr.code;
  if (anyErr && typeof anyErr.message === "string" && anyErr.message) return anyErr.message;
  return String(err);
}

/** Test-only: clear the dedupe state so each test starts with a clean slate. */
export function __resetDisabledSlugsFailureLogForTests(): void {
  loggedDisabledSlugsFailures.clear();
}

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
    return data ? Boolean(data.enabled) : defaultEnabledFor(slug); // no row => the slug's default
  } catch (err) {
    // Fail-open, EXCEPT for a default-off slug, which fails closed.
    const fallback = defaultEnabledFor(slug);
    console.error(
      `[systems] isSystemEnabled(${clientId}, ${slug}) failed; defaulting to ${fallback ? "enabled" : "DISABLED"}`,
      err,
    );
    return fallback;
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
    return data ? Boolean(data.enabled) : defaultEnabledFor(slug); // no row => the slug's default
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
    // Read enabled as well as disabled rows: a default-off slug is disabled unless
    // an explicit row says otherwise, which cannot be established from the
    // disabled rows alone.
    const { data, error } = await serviceClient()
      .from(TABLE)
      .select("module_slug, enabled")
      .eq("client_id", clientId);
    if (error) throw error;
    return disabledSetFrom(data as ToggleRow[] | null);
  } catch (err) {
    const key = `${clientId}::${disabledSlugsFailureReason(err)}`;
    if (!loggedDisabledSlugsFailures.has(key)) {
      if (loggedDisabledSlugsFailures.size >= MAX_TRACKED_DISABLED_SLUGS_FAILURES) {
        loggedDisabledSlugsFailures.clear();
      }
      loggedDisabledSlugsFailures.add(key);
      console.error(
        `[systems] getDisabledSlugs(${clientId}) failed; defaulting to none disabled except the default-off slugs`,
        err,
      );
    }
    // Fail-open for everything except the default-off slugs, which stay disabled.
    return new Set(DEFAULT_OFF_SLUGS);
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
    return data ? Boolean(data.enabled) : defaultEnabledFor(slug); // no row => the slug's default
  } catch (err) {
    // A default-off slug fails closed whatever the dry-run flag says: it is not
    // safe to arm a system nobody has switched on, simulated sends or not.
    const failOpen = isDryRun() && defaultEnabledFor(slug);
    console.error(
      `[systems] isSystemEnabledForSend(${clientId}, ${slug}) failed; ` +
        (failOpen ? "dry-run so defaulting to enabled" : "failing CLOSED (disabled)"),
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
      .select("module_slug, enabled")
      .eq("client_id", clientId);
    if (error) throw error;
    return disabledSetFrom(data as ToggleRow[] | null);
  } catch (err) {
    const failOpen = isDryRun();
    console.error(
      `[systems] getDisabledSlugsForSend(${clientId}) failed; ` +
        (failOpen
          ? "dry-run so defaulting to none disabled except the default-off slugs"
          : "messaging is LIVE so failing CLOSED (all disabled)"),
      err,
    );
    // Even fail-open keeps the default-off slugs disabled.
    return failOpen ? new Set(DEFAULT_OFF_SLUGS) : new Set(SYSTEM_SLUGS);
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
      enabled: row ? Boolean(row.enabled) : defaultEnabledFor(s.slug),
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
