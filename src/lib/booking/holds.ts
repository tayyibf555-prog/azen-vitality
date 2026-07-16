import { serviceClient } from "@/lib/supabase/server";

// booking_hold (migration 0042): step 1 of the two-step public booking. A hold
// records a patient's chosen slot + contact so we can HOLD the time without yet
// writing to Dentally; step 2 confirms and the existing gated create path makes
// the real appointment (flipping the hold to 'confirmed'). A hold left 'held'
// past the abandonment window is converted to a speed-to-lead lead by the SLA
// sweep, then marked 'expired'.
//
// Server-only: every function goes through the service-role client.

export type HoldStatus = "held" | "confirmed" | "expired";

export interface BookingHold {
  id: string;
  clientId: string;
  siteId: string;
  slotStart: string;
  slotFinish: string;
  practitionerId: string | null;
  practitionerName: string | null;
  treatment: string;
  name: string;
  phone: string;
  email: string | null;
  status: HoldStatus;
  createdAt: string;
  updatedAt: string;
}

interface HoldRow {
  id: string;
  client_id: string;
  site_id: string;
  slot_start: string;
  slot_finish: string;
  practitioner_id: string | null;
  practitioner_name: string | null;
  treatment: string;
  name: string;
  phone: string;
  email: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

function rowToHold(r: HoldRow): BookingHold {
  return {
    id: r.id,
    clientId: r.client_id,
    siteId: r.site_id,
    slotStart: r.slot_start,
    slotFinish: r.slot_finish,
    practitionerId: r.practitioner_id,
    practitionerName: r.practitioner_name,
    treatment: r.treatment,
    name: r.name,
    phone: r.phone,
    email: r.email,
    status: r.status as HoldStatus,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface CreateHoldInput {
  clientId: string;
  siteId: string;
  slotStart: string;
  slotFinish: string;
  practitionerId?: string | null;
  practitionerName?: string | null;
  treatment?: string | null;
  name: string;
  phone: string;
  email?: string | null;
}

/** Record a new hold (status 'held'). NO Dentally write happens here. */
export async function createHold(input: CreateHoldInput): Promise<BookingHold> {
  const db = serviceClient();
  const { data, error } = await db
    .from("booking_hold")
    .insert({
      client_id: input.clientId,
      site_id: input.siteId,
      slot_start: input.slotStart,
      slot_finish: input.slotFinish,
      practitioner_id: input.practitionerId ?? null,
      practitioner_name: input.practitionerName ?? null,
      treatment: input.treatment ?? "Exam",
      name: input.name,
      phone: input.phone,
      email: input.email ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  return rowToHold(data as HoldRow);
}

/**
 * Flip a hold 'held' -> 'confirmed' once the real appointment is booked. Scoped
 * to (id, site_id) and only from 'held' so a stale/foreign id is a harmless
 * no-op. Best-effort at the call site: a completed booking must never fail
 * because its hold could not be stamped.
 */
export async function markHoldConfirmed(id: string, siteId: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("booking_hold")
    .update({ status: "confirmed", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("site_id", siteId)
    .eq("status", "held");
  if (error) throw error;
}

/** Flip a hold to 'expired' (used after converting an abandoned hold to a lead). */
export async function markHoldExpired(id: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("booking_hold")
    .update({ status: "expired", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "held");
  if (error) throw error;
}

/**
 * Holds still 'held' and therefore abandoned: created before `olderThanIso` (the
 * ~20-minute abandonment window) but no earlier than `freshestIso` (a staleness
 * floor mirroring the SLA sweep's 48h guard, so flipping the system on can never
 * blast a backlog of ancient holds with "we're holding your time"). Oldest first,
 * bounded by `limit`.
 */
export async function listAbandonedHolds(
  olderThanIso: string,
  freshestIso: string,
  limit: number,
): Promise<BookingHold[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("booking_hold")
    .select("*")
    .eq("status", "held")
    .lt("created_at", olderThanIso)
    .gte("created_at", freshestIso)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data as HoldRow[]).map(rowToHold);
}
