import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { londonDayEndIso, londonDayStartIso } from "@/lib/calendar/availability";
import type { ClockEvent, ClockKind, ClockSource, ClockStaff } from "./types";

// ===========================================================================
// public.staff_clock_event -- server-only reads and writes (service role).
//
// APPEND ONLY. There is an insert and there are reads, and there is deliberately
// no update and no delete: a mistaken tap is corrected by RECORDING the
// correction (source 'admin', recorded_by stamped), never by editing the
// original away. The pairing rules in ./pairing.ts then show the practice
// manager both the mistake and the correction, which is the entire reason the
// table is shaped this way (0068_staff_clock.sql).
//
// Every read and every write is scoped by client_id, and the composite FK on
// (client_id, staff_id) means the database refuses a cross-tenant staff id even
// if a guard above ever missed one.
// ===========================================================================

interface EventRow {
  id: string;
  client_id: string;
  site_id: string;
  staff_id: string;
  kind: string;
  occurred_at: string;
  source: string;
  recorded_by: string | null;
  note: string | null;
  created_at: string;
}

function rowToEvent(r: EventRow): ClockEvent {
  return {
    id: r.id,
    clientId: r.client_id,
    siteId: r.site_id,
    staffId: r.staff_id,
    kind: r.kind as ClockKind,
    occurredAt: r.occurred_at,
    source: r.source as ClockSource,
    recordedBy: r.recorded_by,
    note: r.note,
    createdAt: r.created_at,
  };
}

/**
 * Whether a Postgres error is "this table/column does not exist yet".
 *
 * 0068 is written by one builder and applied by another, and the dev server here
 * is a live demo. Until the migration lands, the honest answer for a READ is
 * "clocking is not switched on yet", which the page can say out loud. It is not
 * "500". Writes are not given this courtesy: silently accepting a clock-in that
 * was never stored would be worse than an error.
 */
export function isMissingRelation(error: { code?: string } | null): boolean {
  return error?.code === "42P01" || error?.code === "42703";
}

export interface ListEventsOptions {
  /** Inclusive lower bound, ISO instant. */
  fromIso: string;
  /** Inclusive upper bound, ISO instant. */
  toIso: string;
  staffIds?: string[];
  siteIds?: string[];
  /** Hard cap so a wide window can never return an unbounded set. */
  limit?: number;
}

const DEFAULT_EVENT_LIMIT = 500;

/**
 * Clock events for a client inside an instant window, oldest first.
 *
 * Returns `ready: false` (and no events) when the table is not there yet, so a
 * caller can say so rather than crash. Any other error still throws.
 */
export async function listEvents(
  clientId: string,
  opts: ListEventsOptions,
): Promise<{ ready: boolean; events: ClockEvent[] }> {
  const db = serviceClient();
  let q = db
    .from("staff_clock_event")
    .select("*")
    .eq("client_id", clientId)
    .gte("occurred_at", opts.fromIso)
    .lte("occurred_at", opts.toIso);

  if (opts.staffIds) {
    // An explicit empty scope means "nobody", which must return nothing rather
    // than silently widening to everybody.
    if (opts.staffIds.length === 0) return { ready: true, events: [] };
    q = q.in("staff_id", opts.staffIds);
  }
  if (opts.siteIds && opts.siteIds.length > 0) q = q.in("site_id", opts.siteIds);

  const { data, error } = await q
    .order("occurred_at", { ascending: true })
    .limit(opts.limit ?? DEFAULT_EVENT_LIMIT);

  if (error) {
    if (isMissingRelation(error)) return { ready: false, events: [] };
    throw error;
  }
  return { ready: true, events: (data as EventRow[]).map(rowToEvent) };
}

/**
 * Every clock event on one Europe/London calendar day.
 *
 * The window is built with londonInstantMs, not by concatenating "T00:00:00Z":
 * that is an hour out through British Summer Time, so an 00:30 clock-out in
 * July would land on the wrong day and pair against nothing.
 */
export async function listEventsForDay(
  clientId: string,
  dayKey: string,
  opts?: { staffIds?: string[]; siteIds?: string[]; limit?: number },
): Promise<{ ready: boolean; events: ClockEvent[] }> {
  return listEvents(clientId, {
    fromIso: londonDayStartIso(dayKey),
    toIso: londonDayEndIso(dayKey),
    ...opts,
  });
}

export interface RecordEventInput {
  clientId: string;
  siteId: string;
  staffId: string;
  kind: ClockKind;
  /** ISO instant of the tap. */
  occurredAt: string;
  source: ClockSource;
  /** The login that pressed the button, or null when auth is not enforced. */
  recordedBy?: string | null;
  note?: string | null;
}

/** Append one clock event. The only write in this module. */
export async function recordEvent(input: RecordEventInput): Promise<ClockEvent> {
  const db = serviceClient();
  const { data, error } = await db
    .from("staff_clock_event")
    .insert({
      client_id: input.clientId,
      site_id: input.siteId,
      staff_id: input.staffId,
      kind: input.kind,
      occurred_at: input.occurredAt,
      source: input.source,
      recorded_by: input.recordedBy ?? null,
      note: input.note ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  return rowToEvent(data as EventRow);
}

interface StaffRow {
  id: string;
  name: string;
  role: string;
  site_id: string | null;
}

/**
 * The staff record belonging to a login, within one client.
 *
 * THIS is what makes self-service clocking safe. The staff id is resolved from
 * the caller's verified session, never taken from the request body: an endpoint
 * that trusted a body-supplied staffId would let anybody clock anybody in.
 *
 * Returns null when the login is not linked to a staff record (the normal state
 * for most logins), which the caller reads as "no self-service for you", not as
 * an error. Also returns null while 0068 is unapplied, so the page still loads.
 */
export async function findStaffByAppUser(
  clientId: string,
  appUserId: string,
): Promise<ClockStaff | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("rota_staff")
    .select("id, name, role, site_id")
    .eq("client_id", clientId)
    .eq("app_user_id", appUserId)
    .eq("active", true)
    .maybeSingle();
  if (error) {
    if (isMissingRelation(error)) return null;
    throw error;
  }
  if (!data) return null;
  const row = data as StaffRow;
  return { id: row.id, name: row.name, role: row.role, siteId: row.site_id };
}
