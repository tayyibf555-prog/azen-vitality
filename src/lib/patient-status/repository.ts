import { serviceClient } from "@/lib/supabase/server";
import { isDryRun } from "@/lib/messaging/types";
import {
  excludesFromTargeting,
  isPatientAdminStatus,
  type DentallySyncResult,
  type PatientAdminAuditEntry,
  type PatientAdminStatus,
  type PatientStatusOverride,
} from "./types";

// Persistence for patient_status_override + patient_admin_audit (migration 0049).
// Service-role only (RLS-on, no anon/authenticated grants), like patient_note / copilot_action.

interface OverrideRow {
  site_id: string;
  dentally_patient_id: string;
  status: string;
  reason: string | null;
  set_by: string | null;
  set_at: string;
  dentally_synced: boolean;
  dentally_synced_at: string | null;
}

interface AuditRow {
  id: string;
  site_id: string;
  dentally_patient_id: string;
  action: string;
  from_status: string | null;
  to_status: string;
  reason: string | null;
  actor_email: string | null;
  dentally_result: string | null;
  created_at: string;
}

const OVERRIDE_COLS =
  "site_id, dentally_patient_id, status, reason, set_by, set_at, dentally_synced, dentally_synced_at";
const AUDIT_COLS =
  "id, site_id, dentally_patient_id, action, from_status, to_status, reason, actor_email, dentally_result, created_at";

/**
 * EVERY MULTI-ROW READ OF patient_status_override PAGES TO EXHAUSTION. Here is why.
 *
 * Supabase applies a server-side max-rows ceiling to every REST request — measured
 * at 1,000 on this project, with the service-role key, by asking for 1,500 and for
 * 2,001 and receiving exactly 1,000 rows and `content-range: 0-999/*` both times,
 * WITHOUT AN ERROR (the measurement is written up in src/lib/dentally/sync-ledger.ts,
 * which had to drop its count cap to 900 because of it). A clipped response is
 * byte-identical in shape to a complete one: `error` is null and `data` is a valid
 * array. So an unranged `select()` on this table cannot tell "there are 900
 * exclusions" from "there are 4,000 exclusions and you may see 1,000 of them".
 *
 * That matters more here than almost anywhere else in the tree. These rows are the
 * targeting-exclusion list: the patients a human deliberately marked `inactive` or
 * `do_not_contact`. A clipped read hands the sweeps a SHORTER exclusion list and
 * they draft for the difference — and `inactive` has no second barrier at the send
 * choke point the way `do_not_contact` has its message_suppression rows (see
 * applyStatusChange, which writes suppression for do_not_contact only). Ruling
 * W1-B/2 refused to accept that residue for a read ERROR; a silent truncation is
 * the same residue arriving without an error to catch, so it gets the same answer:
 * read every row, or fail.
 *
 * The loop advances by the number of rows ACTUALLY RETURNED and stops only on an
 * empty page, rather than stopping as soon as a page comes back shorter than the
 * window it asked for. That costs one extra round trip at the end and buys
 * independence from the ceiling's value: if the server's max-rows is ever lowered
 * below PAGE, a "short page means the end" loop would silently truncate again on
 * its FIRST page — the exact bug, wearing the fix's clothes.
 */
const OVERRIDE_PAGE = 1000;

/**
 * A hard stop so a server that never returns an empty page cannot spin forever.
 * 200,000 is far beyond any real override count (the practice has ~51,000 patients
 * in total), so reaching it means the read is not behaving; that THROWS rather than
 * returning what was collected, because a partial exclusion list quietly presented
 * as a whole one is the failure this paging exists to prevent.
 */
const OVERRIDE_MAX_ROWS = 200_000;

/**
 * Run a ranged read to exhaustion. `page` is handed the inclusive [from, to] window
 * and must apply a TOTAL ordering (the table's primary key is
 * (site_id, dentally_patient_id), so ordering by both is total and index-backed —
 * a non-unique sort key can shuffle rows between pages and skip some).
 */
async function readAllOverridePages<R>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<R[]> {
  const out: R[] = [];
  for (let from = 0; ; ) {
    const { data, error } = await page(from, from + OVERRIDE_PAGE - 1);
    if (error) throw error;
    const rows = (data as R[] | null) ?? [];
    out.push(...rows);
    if (rows.length === 0) break;
    from += rows.length;
    if (from >= OVERRIDE_MAX_ROWS) {
      throw new Error(
        `patient_status_override read exceeded ${OVERRIDE_MAX_ROWS} rows without reaching the end; ` +
          "refusing to return a partial exclusion list",
      );
    }
  }
  return out;
}

/** Coerce a stored status string to the union, defaulting to 'active' for an unknown
 *  value (fail-safe: never treat a corrupt row as excluding, and never crash a read). */
function coerceStatus(v: string | null): PatientAdminStatus {
  return isPatientAdminStatus(v) ? v : "active";
}

function toOverride(r: OverrideRow): PatientStatusOverride {
  return {
    siteId: r.site_id,
    patientId: r.dentally_patient_id,
    status: coerceStatus(r.status),
    reason: r.reason,
    setBy: r.set_by,
    setAt: r.set_at,
    dentallySynced: r.dentally_synced,
    dentallySyncedAt: r.dentally_synced_at,
  };
}

function toAudit(r: AuditRow): PatientAdminAuditEntry {
  return {
    id: r.id,
    siteId: r.site_id,
    patientId: r.dentally_patient_id,
    action: r.action,
    fromStatus: r.from_status ? coerceStatus(r.from_status) : null,
    toStatus: coerceStatus(r.to_status),
    reason: r.reason,
    actorEmail: r.actor_email,
    dentallyResult: (r.dentally_result as DentallySyncResult | null) ?? null,
    createdAt: r.created_at,
  };
}

/** The current override for one patient at one site, or null when none is set. */
export async function getOverride(siteId: string, patientId: string): Promise<PatientStatusOverride | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("patient_status_override")
    .select(OVERRIDE_COLS)
    .eq("site_id", siteId)
    .eq("dentally_patient_id", patientId)
    .maybeSingle();
  if (error) throw error;
  return data ? toOverride(data as OverrideRow) : null;
}

/** Insert or replace the override row. dentally_synced starts false; a successful
 *  Dentally write flips it via markOverrideSynced, so the platform truth is persisted
 *  BEFORE any remote call and applies immediately even if that call later fails. */
export async function upsertOverride(input: {
  siteId: string;
  patientId: string;
  status: PatientAdminStatus;
  reason: string | null;
  setBy: string | null;
}): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("patient_status_override").upsert(
    {
      site_id: input.siteId,
      dentally_patient_id: input.patientId,
      status: input.status,
      reason: input.reason,
      set_by: input.setBy,
      set_at: new Date().toISOString(),
      dentally_synced: false,
      dentally_synced_at: null,
    },
    { onConflict: "site_id,dentally_patient_id" },
  );
  if (error) throw error;
}

/** Mark that the override reached Dentally (only called after a genuine synced write). */
export async function markOverrideSynced(siteId: string, patientId: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("patient_status_override")
    .update({ dentally_synced: true, dentally_synced_at: new Date().toISOString() })
    .eq("site_id", siteId)
    .eq("dentally_patient_id", patientId);
  if (error) throw error;
}

export async function insertAudit(entry: {
  siteId: string;
  patientId: string;
  action: string;
  fromStatus: PatientAdminStatus | null;
  toStatus: PatientAdminStatus;
  reason: string | null;
  actorEmail: string | null;
  dentallyResult: DentallySyncResult;
}): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("patient_admin_audit").insert({
    site_id: entry.siteId,
    dentally_patient_id: entry.patientId,
    action: entry.action,
    from_status: entry.fromStatus,
    to_status: entry.toStatus,
    reason: entry.reason,
    actor_email: entry.actorEmail,
    dentally_result: entry.dentallyResult,
  });
  if (error) throw error;
}

/** The most recent audit entries for one patient, newest first (default 10). */
export async function listAudit(siteId: string, patientId: string, limit = 10): Promise<PatientAdminAuditEntry[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("patient_admin_audit")
    .select(AUDIT_COLS)
    .eq("site_id", siteId)
    .eq("dentally_patient_id", patientId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as AuditRow[]).map(toAudit);
}

/** All overrides for the given sites (only manually-set ones, but PAGED — see
 *  OVERRIDE_PAGE: past 1,000 of them an unranged read would silently drop the tail and
 *  a do-not-contact chip would go missing from the patients list). Best-effort: logs
 *  and returns [] on error so the list still renders. */
export async function listOverridesForSites(siteIds: string[]): Promise<PatientStatusOverride[]> {
  if (siteIds.length === 0) return [];
  try {
    const db = serviceClient();
    const rows = await readAllOverridePages<OverrideRow>((from, to) =>
      db
        .from("patient_status_override")
        .select(OVERRIDE_COLS)
        .in("site_id", siteIds)
        .order("site_id", { ascending: true })
        .order("dentally_patient_id", { ascending: true })
        .range(from, to),
    );
    return rows.map(toOverride);
  } catch (err) {
    console.error("[patient-status] listOverridesForSites failed; showing no chips", err);
    return [];
  }
}

/** Composite key for the cross-site targeting-exclusion set. */
export function excludedTargetKey(siteId: string, patientId: string): string {
  return `${siteId}::${patientId}`;
}

/**
 * The set of `${siteId}::${patientId}` keys for EVERY override that excludes a patient
 * from targeting (inactive or do_not_contact), across ALL sites. Loaded ONCE per sweep
 * tick (the sweeps span sites), then checked per candidate with excludedTargetKey().
 *
 * FAIL DIRECTION, AND IT CHANGED (ruling W1-B/2, 3 Sep 2026).
 *
 * It used to be fail-OPEN in every case: a read error logged loudly and returned an
 * empty set, and the sweep drafted for everybody. The reasoning was that
 * do_not_contact patients are blocked a second time at the send choke point by
 * their message_suppression rows, so the only person who could slip through was an
 * override-INACTIVE patient — someone a human deliberately took out of targeting.
 * That is not a small residue. Nothing else protects them, and "we could not read
 * the exclusion list, so we messaged everyone" is the wrong sentence to have to say
 * about a patient who asked to be left alone.
 *
 * So: once messaging is LIVE an unreadable exclusion list is a REFUSAL, and this
 * throws ExclusionsUnavailableError. Exclusions unknown means nobody may be
 * drafted; the caller skips the tick and the next one retries. While
 * MESSAGING_DRY_RUN is on it keeps the old behaviour — loud log, empty set — so
 * local development against a partial database still works. That gives `inactive`
 * exactly the protection `do_not_contact` already had from suppression.
 *
 * A skipped tick is a delay. A batch drafted against an unknown exclusion list is
 * an incident.
 *
 * BOTH EXCLUSION READS NOW REFUSE. The ruling was written against this function and
 * its seven sweeps, and the single-site variant below (loadExcludedPatientIds, the
 * outreach audience builder's only exclusion check) was left fail-open with a comment
 * claiming it matched. It refuses too, from 4 Sep 2026 — see the note on it for why
 * that path had the least room of all to be forgiving.
 */
export class ExclusionsUnavailableError extends Error {
  constructor(readonly cause: unknown) {
    super(
      "the patient targeting-exclusion list could not be read, and messaging is live; " +
        "nobody may be drafted this tick",
    );
    this.name = "ExclusionsUnavailableError";
  }
}

/** Whether an unknown error is the exclusion refusal, for a caller's catch block. */
export function isExclusionsUnavailable(err: unknown): err is ExclusionsUnavailableError {
  return err instanceof ExclusionsUnavailableError;
}

export async function loadExcludedTargetKeys(): Promise<Set<string>> {
  try {
    const db = serviceClient();
    // PAGED TO EXHAUSTION (see OVERRIDE_PAGE). The refusal below only catches a read
    // that THROWS; PostgREST's row ceiling does not throw, it just hands back the
    // first 1,000 rows, so without this loop the one failure mode ruling W1-B/2 was
    // written about would arrive in the shape the ruling cannot see.
    const rows = await readAllOverridePages<Pick<OverrideRow, "site_id" | "dentally_patient_id" | "status">>(
      (from, to) =>
        db
          .from("patient_status_override")
          .select("site_id, dentally_patient_id, status")
          .in("status", ["inactive", "do_not_contact"])
          .order("site_id", { ascending: true })
          .order("dentally_patient_id", { ascending: true })
          .range(from, to),
    );
    const set = new Set<string>();
    for (const row of rows) {
      if (excludesFromTargeting(coerceStatus(row.status))) {
        set.add(excludedTargetKey(row.site_id, row.dentally_patient_id));
      }
    }
    return set;
  } catch (err) {
    if (!isDryRun()) {
      console.error(
        "[patient-status] loadExcludedTargetKeys failed and messaging is LIVE; refusing the tick " +
          "rather than drafting for patients who may be marked inactive or do-not-contact",
        err,
      );
      throw new ExclusionsUnavailableError(err);
    }
    console.error(
      "[patient-status] loadExcludedTargetKeys failed; dry-run, so targeting proceeds without overrides this tick",
      err,
    );
    return new Set();
  }
}

/**
 * The set of `${siteId}::${patientId}` keys for patients marked do_not_contact ONLY
 * (not inactive), across the given sites. Used by staff-review surfaces (the leads view)
 * to flag an incoming enquiry from a do-not-contact patient so staff review the status
 * before acting. Best-effort: logs and returns an empty set on error.
 */
export async function loadDoNotContactKeys(siteIds: string[]): Promise<Set<string>> {
  if (siteIds.length === 0) return new Set();
  try {
    const db = serviceClient();
    // PAGED (see OVERRIDE_PAGE): a clipped read here is a MISSING FLAG on a staff
    // screen — an enquiry from a do-not-contact patient that looks like any other.
    const rows = await readAllOverridePages<Pick<OverrideRow, "site_id" | "dentally_patient_id" | "status">>(
      (from, to) =>
        db
          .from("patient_status_override")
          .select("site_id, dentally_patient_id, status")
          .in("site_id", siteIds)
          .eq("status", "do_not_contact")
          .order("site_id", { ascending: true })
          .order("dentally_patient_id", { ascending: true })
          .range(from, to),
    );
    const set = new Set<string>();
    for (const row of rows) {
      set.add(excludedTargetKey(row.site_id, row.dentally_patient_id));
    }
    return set;
  } catch (err) {
    console.error("[patient-status] loadDoNotContactKeys failed; no flags shown", err);
    return new Set();
  }
}

/**
 * The set of dentally_patient_ids excluded from targeting for ONE site. Used by the
 * single-site outreach builder (src/lib/outreach/build.ts).
 *
 * SAME FAIL DIRECTION AS loadExcludedTargetKeys, AND IT CHANGED FOR THE SAME REASON
 * (ruling W1-B/2, applied here 4 Sep 2026).
 *
 * The comment that used to sit here said "same fail-open posture as
 * loadExcludedTargetKeys", and by the time it was read that sentence was false twice
 * over: the sibling had stopped being fail-open, and this one had not. The gap was
 * not cosmetic. On the outreach path the exclusion read is the ONLY barrier that
 * ever runs:
 *
 *   - the audience is a SNAPSHOT. build.ts checks the set once per patient as it
 *     enrols them into outreach_target, and sweepCampaign never consults it again —
 *     it re-checks target status, pending touches, consent and the daily cap only.
 *     An exclusion missed at build time is missed for the life of the campaign;
 *   - there is no second net at the send choke point for `inactive`. applyStatusChange
 *     writes message_suppression rows for `do_not_contact` ONLY, so the drain has
 *     nothing to stop on;
 *   - and the build pass is deliberately ungated by the outreach kill switch (building
 *     a list is not sending), so it runs on every sweep tick regardless.
 *
 * So a single transient blip on this table, while messaging is live, could enrol a
 * patient a receptionist had marked `inactive` — permanently. Once messaging is LIVE
 * an unreadable exclusion list is therefore a REFUSAL here too: this throws
 * ExclusionsUnavailableError, the build tick makes no progress, and the next tick
 * resumes on the same page (a delay, not an incident). Under MESSAGING_DRY_RUN it
 * keeps the old behaviour — loud log, empty set — so local work is unaffected.
 */
export async function loadExcludedPatientIds(siteId: string): Promise<Set<string>> {
  try {
    const db = serviceClient();
    // PAGED (see OVERRIDE_PAGE) for the same reason as the cross-site read: past the
    // ceiling an unranged select would hand the builder a shorter exclusion list with
    // no error to catch, and every patient past it would be enrolled for good.
    const rows = await readAllOverridePages<Pick<OverrideRow, "dentally_patient_id" | "status">>((from, to) =>
      db
        .from("patient_status_override")
        .select("dentally_patient_id, status")
        .eq("site_id", siteId)
        .in("status", ["inactive", "do_not_contact"])
        .order("dentally_patient_id", { ascending: true })
        .range(from, to),
    );
    const set = new Set<string>();
    for (const row of rows) {
      if (excludesFromTargeting(coerceStatus(row.status))) set.add(row.dentally_patient_id);
    }
    return set;
  } catch (err) {
    if (!isDryRun()) {
      console.error(
        `[patient-status] loadExcludedPatientIds failed for ${siteId} and messaging is LIVE; refusing the ` +
          "build tick rather than enrolling patients who may be marked inactive or do-not-contact",
        err,
      );
      throw new ExclusionsUnavailableError(err);
    }
    console.error(
      `[patient-status] loadExcludedPatientIds failed for ${siteId}; dry-run, so the build proceeds without overrides`,
      err,
    );
    return new Set();
  }
}
