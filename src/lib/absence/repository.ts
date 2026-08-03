import { serviceClient } from "@/lib/supabase/server";
import type { Absence, AbsenceDecision, AbsenceKind, AbsenceStatus } from "./types";

// ---------------------------------------------------------------------------
// Server-only CRUD for staff_absence (service-role), mirroring rota/repository.ts.
//
// Two house rules are load-bearing here:
//  1. EVERY read and write carries `.eq("client_id", clientId)`. The composite FK in
//     0067 makes a cross-tenant row impossible to create, and this makes a
//     cross-tenant row impossible to read or change.
//  2. Every write ends `.select("id")` so a 0-row match is distinguishable from a
//     successful update. Without it Supabase reports success for an update that
//     touched nothing, and the API answers `{ok:true}` to a stale or foreign id
//     (rota/repository.ts:125-161 is the same pattern for the same reason).
//
// Staff are EMPLOYEES, so there is no patient consent gate anywhere in this file.
// ---------------------------------------------------------------------------

interface AbsenceRow {
  id: string;
  client_id: string;
  site_id: string | null;
  staff_id: string;
  kind: string;
  start_date: string;
  end_date: string;
  status: string;
  note: string | null;
  requested_by: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
}

/**
 * Postgres `date` columns come back as `YYYY-MM-DD` already, but a driver or a view
 * can hand back a full timestamp. Trimming to ten characters keeps every day key in
 * the one comparable shape the rules expect.
 */
function dayKey(value: string): string {
  return typeof value === "string" ? value.slice(0, 10) : value;
}

function rowToAbsence(r: AbsenceRow): Absence {
  return {
    id: r.id,
    clientId: r.client_id,
    siteId: r.site_id,
    staffId: r.staff_id,
    kind: r.kind as AbsenceKind,
    startDate: dayKey(r.start_date),
    endDate: dayKey(r.end_date),
    status: r.status as AbsenceStatus,
    note: r.note,
    requestedBy: r.requested_by,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    decisionNote: r.decision_note,
    createdAt: r.created_at,
  };
}

export interface ListAbsenceOptions {
  /** Keep absences that touch `[from, to]` at all (inclusive `YYYY-MM-DD` day keys). */
  from?: string;
  to?: string;
  staffId?: string;
  statuses?: AbsenceStatus[];
  /** Restrict to these sites, plus floating staff whose absence has no site. */
  siteIds?: string[];
}

/**
 * A client's absences, newest start date first.
 *
 * The window test is OVERLAP, not containment: an absence that started last month and
 * runs into next week is very much relevant to this week, and a naive
 * `start_date >= from` would hide exactly the person who is off right now.
 */
export async function listAbsence(clientId: string, opts: ListAbsenceOptions = {}): Promise<Absence[]> {
  const db = serviceClient();
  let q = db.from("staff_absence").select("*").eq("client_id", clientId);
  if (opts.from) q = q.gte("end_date", opts.from);
  if (opts.to) q = q.lte("start_date", opts.to);
  if (opts.staffId) q = q.eq("staff_id", opts.staffId);
  if (opts.statuses && opts.statuses.length > 0) q = q.in("status", opts.statuses);
  // Site scope mirrors listStaff: the selected site(s) PLUS floating staff (site_id
  // null), who work across sites and whose absence affects every site.
  if (opts.siteIds && opts.siteIds.length > 0) {
    q = q.or(`site_id.in.(${opts.siteIds.join(",")}),site_id.is.null`);
  }
  const { data, error } = await q
    .order("start_date", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data as AbsenceRow[]).map(rowToAbsence);
}

/**
 * Every APPROVED absence overlapping `[from, to]`, for the rota generator.
 *
 * Deliberately status-filtered in SQL as well as in `absenceBlocksShift`: the
 * generator should never even see a pending request, so a future caller that forgets
 * the pure rule still cannot un-roster somebody on an undecided request.
 */
export async function listApprovedAbsence(clientId: string, from: string, to: string): Promise<Absence[]> {
  return listAbsence(clientId, { from, to, statuses: ["approved"] });
}

/** A single absence, scoped to the caller's client so a foreign id reads as absent. */
export async function getAbsence(id: string, clientId: string): Promise<Absence | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("staff_absence")
    .select("*")
    .eq("id", id)
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToAbsence(data as AbsenceRow) : null;
}

export interface CreateAbsenceInput {
  clientId: string;
  siteId?: string | null;
  staffId: string;
  kind: AbsenceKind;
  startDate: string;
  endDate: string;
  note?: string | null;
  requestedBy?: string | null;
}

/** Store a new request. Always lands as `pending`: nothing is self-approved on the way in. */
export async function createAbsence(input: CreateAbsenceInput): Promise<Absence> {
  const db = serviceClient();
  const { data, error } = await db
    .from("staff_absence")
    .insert({
      client_id: input.clientId,
      site_id: input.siteId ?? null,
      staff_id: input.staffId,
      kind: input.kind,
      start_date: input.startDate,
      end_date: input.endDate,
      status: "pending",
      note: input.note ?? null,
      requested_by: input.requestedBy ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  return rowToAbsence(data as AbsenceRow);
}

/**
 * Record a decision. Returns false when no row matched, so the API can answer 404
 * rather than a misleading `{ok:true}` for a stale or cross-tenant id.
 *
 * The `.eq("status", "pending")` is not decoration: it makes the write itself the
 * race guard. Two managers pressing Approve and Refuse at the same moment would both
 * pass the pure `canDecide` check against the row they each read; only the first
 * write matches here, and the second returns false and is told the request has
 * already been decided.
 */
export async function decideAbsence(
  id: string,
  clientId: string,
  decision: AbsenceDecision,
  decidedBy: string | null,
  decisionNote?: string | null,
): Promise<boolean> {
  const db = serviceClient();
  const { data, error } = await db
    .from("staff_absence")
    .update({
      status: decision,
      decided_by: decidedBy,
      decided_at: new Date().toISOString(),
      decision_note: decisionNote ?? null,
    })
    .eq("id", id)
    .eq("client_id", clientId)
    .eq("status", "pending")
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

/**
 * Withdraw a request or an already-agreed absence. Returns false when no live row
 * matched (unknown id, another client's id, or one already refused or cancelled).
 */
export async function cancelAbsence(id: string, clientId: string): Promise<boolean> {
  const db = serviceClient();
  const { data, error } = await db
    .from("staff_absence")
    .update({ status: "cancelled" })
    .eq("id", id)
    .eq("client_id", clientId)
    .in("status", ["pending", "approved"])
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}
