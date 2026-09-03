import { serviceClient } from "@/lib/supabase/server";
import type { BlockedReason, DentallyWriteKind, WriteIntentStatus } from "./write-vocabulary";
import { WRITE_INTENT_STATUSES } from "./write-vocabulary";

// The vocabulary (kinds, statuses, blocked reasons and their owner-facing
// wording) lives in the PURE LEAF ./write-vocabulary so the browser can read it
// without this file's Supabase client. Re-exported here because every existing
// caller imports it from the ledger, and moving a file should not move an import.
export {
  BLOCKED_REASONS,
  BLOCKED_REASON_COPY,
  DENTALLY_WRITE_KINDS,
  WRITE_INTENT_STATUSES,
  type BlockedReason,
  type DentallyWriteKind,
  type WriteIntentStatus,
} from "./write-vocabulary";

// Persistence for the Dentally sync ledger (table dentally_write_intent,
// migration 0096). One row per outbound Dentally write the platform makes,
// attempts, simulates or refuses.
//
// EVERY WRITE HERE IS FAIL-SOFT, AND THAT IS THE ORDERING DECISION OF THIS LANE.
// The ledger is a RECORD of a booking, never a precondition for one. If the
// insert fails — the migration has not been applied, the table is briefly
// unreachable, PostgREST is unhappy about a column — the recorder logs loudly
// and returns null, and the write path carries on exactly as it did before the
// ledger existed. A patient must never lose an appointment because a row about
// that appointment could not be written.
//
// THE READS ARE BOUNDED, and say so. `listWriteIntents` caps at ROW_CAP and
// reports whether it hit the cap; `countWriteIntents` scans at most COUNT_CAP
// rows and reports `capped`, so the surface can say "at least 2,000" in words
// rather than printing a cap as if it were a total (the honest-numbers rule).

const TABLE = "dentally_write_intent";

export interface WriteIntentInput {
  clientId: string;
  siteId?: string | null;
  kind: DentallyWriteKind;
  source: string;
  moduleSlug: string | null;
  dentallyPatientId?: string | null;
  dentallyAppointmentId?: string | null;
  /** The host the write was aimed at, e.g. "api.dentally.co" or "localhost:3000". */
  target: string;
  payloadSummary: Record<string, unknown>;
  status: WriteIntentStatus;
  blockedReason?: BlockedReason | null;
  actor?: string | null;
  responseId?: string | null;
  error?: string | null;
}

export interface WriteIntentRow {
  id: string;
  clientId: string;
  siteId: string | null;
  kind: string;
  source: string;
  moduleSlug: string | null;
  dentallyPatientId: string | null;
  dentallyAppointmentId: string | null;
  target: string;
  payloadSummary: Record<string, unknown>;
  status: string;
  blockedReason: string | null;
  actor: string | null;
  responseId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string | null;
}

/** The most rows one list read will return, and the most one count will scan. */
export const ROW_CAP = 200;
export const COUNT_CAP = 2000;

/**
 * A Dentally error body can echo the fields it rejected, and a 422 on a patient
 * registration is exactly the case where those fields are a real person's contact
 * details. So the message is truncated and anything shaped like an email address
 * or a phone number is replaced before it is stored.
 *
 * Deliberately crude and deliberately over-eager: it is better to redact a
 * harmless number out of an error string than to file a patient's mobile in a
 * table nobody thinks of as holding contact details. The status code and the
 * shape of the complaint survive, which is what makes the row actionable.
 */
export function sanitiseWriteError(err: unknown): string {
  const raw =
    err instanceof Error ? `${err.name}: ${err.message}` : typeof err === "string" ? err : String(err);
  return raw
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/(?:\+|\b00)\d[\d\s-]{7,}\d/g, "[phone]")
    .replace(/\b0\d[\d\s-]{7,}\d\b/g, "[phone]")
    .slice(0, 500);
}

function toRow(r: Record<string, unknown>): WriteIntentRow {
  const summary = r.payload_summary;
  return {
    id: String(r.id ?? ""),
    clientId: String(r.client_id ?? ""),
    siteId: typeof r.site_id === "string" ? r.site_id : null,
    kind: String(r.kind ?? ""),
    source: String(r.source ?? ""),
    moduleSlug: typeof r.module_slug === "string" ? r.module_slug : null,
    dentallyPatientId: typeof r.dentally_patient_id === "string" ? r.dentally_patient_id : null,
    dentallyAppointmentId: typeof r.dentally_appointment_id === "string" ? r.dentally_appointment_id : null,
    target: String(r.target ?? ""),
    payloadSummary: summary && typeof summary === "object" ? (summary as Record<string, unknown>) : {},
    status: String(r.status ?? ""),
    blockedReason: typeof r.blocked_reason === "string" ? r.blocked_reason : null,
    actor: typeof r.actor === "string" ? r.actor : null,
    responseId: typeof r.response_id === "string" ? r.response_id : null,
    error: typeof r.error === "string" ? r.error : null,
    createdAt: String(r.created_at ?? ""),
    updatedAt: typeof r.updated_at === "string" ? r.updated_at : null,
  };
}

// ---------------------------------------------------------------------------
// DEDUPE for the fail-soft log line, the same shape (and for the same reason) as
// getDisabledSlugs' in src/lib/systems/repository.ts.
//
// Until migration 0096 is applied, EVERY intent fails the same way. This runs on
// the booking path, the diary path, the agent path and two staff paths, so
// without a dedupe one un-migrated deployment fills the server log with hundreds
// of identical lines and buries whatever error actually matters. The FIRST
// occurrence of a given reason logs loudly; exact repeats stay quiet, and a
// DIFFERENT reason still logs, because a new fault appearing behind an old one
// is precisely what a dedupe must not swallow.
// ---------------------------------------------------------------------------

const MAX_TRACKED_LEDGER_FAILURES = 200;
const loggedLedgerFailures = new Set<string>();

function ledgerFailureReason(err: unknown): string {
  const anyErr = err as { code?: unknown; message?: unknown } | null | undefined;
  if (anyErr && typeof anyErr.code === "string" && anyErr.code) return anyErr.code;
  if (anyErr && typeof anyErr.message === "string" && anyErr.message) return anyErr.message;
  return String(err);
}

/** Test-only: clear the dedupe state so each test starts with a clean slate. */
export function __resetLedgerFailureLogForTests(): void {
  loggedLedgerFailures.clear();
}

/**
 * File one intent. Returns its id, or null when the ledger could not be written.
 * NEVER THROWS — see the fail-soft note at the head of this file.
 */
export async function recordWriteIntent(input: WriteIntentInput): Promise<string | null> {
  try {
    const { data, error } = await serviceClient()
      .from(TABLE)
      .insert({
        client_id: input.clientId,
        site_id: input.siteId ?? null,
        kind: input.kind,
        source: input.source,
        module_slug: input.moduleSlug,
        dentally_patient_id: input.dentallyPatientId ?? null,
        dentally_appointment_id: input.dentallyAppointmentId ?? null,
        target: input.target,
        payload_summary: input.payloadSummary,
        status: input.status,
        blocked_reason: input.blockedReason ?? null,
        actor: input.actor ?? null,
        response_id: input.responseId ?? null,
        error: input.error ?? null,
      })
      .select("id")
      .maybeSingle();
    if (error) throw error;
    const id = (data as { id?: unknown } | null)?.id;
    return typeof id === "string" ? id : null;
  } catch (err) {
    const key = `${input.clientId}::${ledgerFailureReason(err)}`;
    if (!loggedLedgerFailures.has(key)) {
      if (loggedLedgerFailures.size >= MAX_TRACKED_LEDGER_FAILURES) loggedLedgerFailures.clear();
      loggedLedgerFailures.add(key);
      console.error(
        `[dentally-ledger] could not record a ${input.status} ${input.kind} intent for ${input.clientId}; ` +
          "the write path is unaffected",
        err,
      );
    }
    return null;
  }
}

/**
 * Move an existing intent to a terminal status. This is the queued -> sent
 * transition: an intent recorded while the write key was missing is replayed
 * later and stamped with what Dentally actually said.
 *
 * NEVER THROWS, for the same reason as recordWriteIntent. Returns whether the
 * stamp landed, so a replay path can tell the difference between "Dentally
 * accepted it and we recorded that" and "Dentally accepted it and our note about
 * it did not land" — which are different facts and must not be reported as one.
 */
export async function settleWriteIntent(
  id: string,
  outcome: { status: Extract<WriteIntentStatus, "sent" | "failed">; responseId?: string | null; error?: string | null },
): Promise<boolean> {
  if (!id) return false;
  try {
    const { error } = await serviceClient()
      .from(TABLE)
      .update({
        status: outcome.status,
        response_id: outcome.responseId ?? null,
        // A settled row can never carry a blocked_reason: the database refuses it
        // (0096), and a stale reason on a row that has since been sent would be a
        // sentence about something that did not happen.
        blocked_reason: null,
        error: outcome.error ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    if (error) throw error;
    return true;
  } catch (err) {
    console.error(`[dentally-ledger] could not settle intent ${id} as ${outcome.status}`, err);
    return false;
  }
}

/**
 * One practice's intents, newest first. BOUNDED: at most `limit` rows (capped at
 * ROW_CAP), and `more` says whether there were others rather than letting a
 * truncated page wear a complete list's clothes.
 *
 * Propagates its error rather than swallowing it: this is a display read, and the
 * Sync Status surface must be able to say "we could not read the ledger" instead
 * of rendering an empty table that reads as "nothing has ever been written".
 */
export async function listWriteIntents(
  clientId: string,
  opts: { limit?: number; status?: WriteIntentStatus } = {},
): Promise<{ rows: WriteIntentRow[]; more: boolean }> {
  const limit = Math.max(1, Math.min(opts.limit ?? ROW_CAP, ROW_CAP));
  let query = serviceClient()
    .from(TABLE)
    .select(
      "id, client_id, site_id, kind, source, module_slug, dentally_patient_id, dentally_appointment_id, " +
        "target, payload_summary, status, blocked_reason, actor, response_id, error, created_at, updated_at",
    )
    .eq("client_id", clientId);
  if (opts.status) query = query.eq("status", opts.status);
  // One more than asked for, so "there are others" is proven rather than guessed
  // from a full page.
  const { data, error } = await query.order("created_at", { ascending: false }).limit(limit + 1);
  if (error) throw error;
  const all = (data ?? []) as unknown as Record<string, unknown>[];
  return { rows: all.slice(0, limit).map(toRow), more: all.length > limit };
}

/**
 * How many intents sit in each status for one practice.
 *
 * BOUNDED AND HONEST. It reads at most COUNT_CAP status values; if it hits the
 * cap the numbers are a FLOOR, not a total, and `capped` says so, so the surface
 * prints "at least 2,000" in words. A cap is never reported as a total (the
 * honest-numbers rule).
 */
export async function countWriteIntents(
  clientId: string,
): Promise<{ counts: Record<WriteIntentStatus, number>; total: number; capped: boolean }> {
  const counts: Record<WriteIntentStatus, number> = {
    dry_run: 0,
    queued: 0,
    sent: 0,
    failed: 0,
    blocked: 0,
  };
  const { data, error } = await serviceClient()
    .from(TABLE)
    .select("status")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false })
    .limit(COUNT_CAP + 1);
  if (error) throw error;
  const rows = (data ?? []) as Array<{ status?: unknown }>;
  const capped = rows.length > COUNT_CAP;
  for (const r of rows.slice(0, COUNT_CAP)) {
    const s = String(r.status ?? "");
    if ((WRITE_INTENT_STATUSES as readonly string[]).includes(s)) counts[s as WriteIntentStatus] += 1;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { counts, total, capped };
}
