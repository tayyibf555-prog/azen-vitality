import { serviceClient } from "@/lib/supabase/server";
import { DEFAULT_ROTA_CONFIG, normaliseConfig } from "./config";
import type { Availability, RotaConfig, RotaShift, RotaShiftStatus, RotaStaff } from "./types";

// Server-only CRUD for the rota tables (service-role). Owners/managers manage staff
// + config via requireOwnerRole-guarded APIs; the generate + sweep endpoints read
// staff/config and write shifts. Staff are employees, so there is no consent gate.

// ---------------------------------------------------------------------------
// Staff.
// ---------------------------------------------------------------------------

interface StaffRow {
  id: string;
  client_id: string;
  site_id: string | null;
  name: string;
  role: string;
  phone: string | null;
  email: string | null;
  active: boolean;
  availability: Record<string, unknown> | null;
  created_at: string;
}

function normaliseAvailability(raw: Record<string, unknown> | null): Availability {
  const out: Availability = {};
  if (!raw || typeof raw !== "object") return out;
  for (const day of ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const) {
    if (raw[day] === true) out[day] = true;
    else if (raw[day] === false) out[day] = false;
  }
  return out;
}

function rowToStaff(r: StaffRow): RotaStaff {
  return {
    id: r.id,
    clientId: r.client_id,
    siteId: r.site_id,
    name: r.name,
    role: r.role,
    phone: r.phone,
    email: r.email,
    active: r.active,
    availability: normaliseAvailability(r.availability),
    createdAt: r.created_at,
  };
}

export async function listStaff(clientId: string, opts?: { activeOnly?: boolean }): Promise<RotaStaff[]> {
  const db = serviceClient();
  let q = db.from("rota_staff").select("*").eq("client_id", clientId);
  if (opts?.activeOnly) q = q.eq("active", true);
  const { data, error } = await q.order("created_at", { ascending: true });
  if (error) throw error;
  return (data as StaffRow[]).map(rowToStaff);
}

export async function getStaff(id: string, clientId: string): Promise<RotaStaff | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("rota_staff")
    .select("*")
    .eq("id", id)
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToStaff(data as StaffRow) : null;
}

export interface CreateStaffInput {
  clientId: string;
  siteId?: string | null;
  name: string;
  role: string;
  phone?: string | null;
  email?: string | null;
  active?: boolean;
  availability?: Availability;
}

export async function createStaff(input: CreateStaffInput): Promise<RotaStaff> {
  const db = serviceClient();
  const { data, error } = await db
    .from("rota_staff")
    .insert({
      client_id: input.clientId,
      site_id: input.siteId ?? null,
      name: input.name,
      role: input.role,
      phone: input.phone ?? null,
      email: input.email ?? null,
      active: input.active ?? true,
      availability: input.availability ?? {},
    })
    .select("*")
    .single();
  if (error) throw error;
  return rowToStaff(data as StaffRow);
}

export interface UpdateStaffInput {
  siteId?: string | null;
  name?: string;
  role?: string;
  phone?: string | null;
  email?: string | null;
  active?: boolean;
  availability?: Availability;
}

/** Returns true if a matching staff row was updated; false if none matched (unknown
 *  id, or an id owned by another client). Lets the API answer 404 instead of a
 *  misleading {ok:true} for a cross-tenant or stale id. */
export async function updateStaff(id: string, clientId: string, fields: UpdateStaffInput): Promise<boolean> {
  const patch: Record<string, unknown> = {};
  if (fields.siteId !== undefined) patch.site_id = fields.siteId;
  if (fields.name !== undefined) patch.name = fields.name;
  if (fields.role !== undefined) patch.role = fields.role;
  if (fields.phone !== undefined) patch.phone = fields.phone;
  if (fields.email !== undefined) patch.email = fields.email;
  if (fields.active !== undefined) patch.active = fields.active;
  if (fields.availability !== undefined) patch.availability = fields.availability;
  if (Object.keys(patch).length === 0) return true; // nothing to change -> no-op success

  const db = serviceClient();
  const { data, error } = await db
    .from("rota_staff")
    .update(patch)
    .eq("id", id)
    .eq("client_id", clientId) // scope the write to the caller's client
    .select("id"); // so we can tell a real update from a 0-row (cross-tenant / unknown id) match
  if (error) throw error;
  const matched = (data?.length ?? 0) > 0;

  // Deactivating a staff member must not strand their future shifts as 'scheduled':
  // they would still read as staffed on the rota, and the next generation would add a
  // REPLACEMENT on top (double coverage). Cancel their future, not-yet-elapsed shifts
  // in the same operation so the slot is genuinely freed for someone else.
  if (matched && fields.active === false) {
    const today = new Date().toISOString().slice(0, 10);
    const { error: shiftErr } = await db
      .from("rota_shift")
      .update({ status: "cancelled" })
      .eq("staff_id", id)
      .gte("shift_date", today)
      .in("status", ["scheduled", "notified"]);
    if (shiftErr) throw shiftErr;
  }
  return matched;
}

/** Returns true if a matching staff row was deleted; false if none matched. */
export async function deleteStaff(id: string, clientId: string): Promise<boolean> {
  const db = serviceClient();
  // rota_shift.staff_id has ON DELETE CASCADE, so their shifts are removed too.
  const { data, error } = await db
    .from("rota_staff")
    .delete()
    .eq("id", id)
    .eq("client_id", clientId)
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Config.
// ---------------------------------------------------------------------------

/** The client's config, or the defaults if none is saved yet. Never throws null. */
export async function getConfig(clientId: string): Promise<RotaConfig> {
  const db = serviceClient();
  const { data, error } = await db
    .from("rota_config")
    .select("config")
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { ...DEFAULT_ROTA_CONFIG };
  return normaliseConfig((data as { config: unknown }).config);
}

export async function saveConfig(clientId: string, config: RotaConfig): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("rota_config")
    .upsert(
      { client_id: clientId, config, updated_at: new Date().toISOString() },
      { onConflict: "client_id" },
    );
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Shifts.
// ---------------------------------------------------------------------------

interface ShiftRow {
  id: string;
  client_id: string;
  site_id: string;
  staff_id: string;
  shift_date: string;
  start_time: string;
  end_time: string;
  role: string;
  status: string;
  notified_at: string | null;
  created_at: string;
}

function rowToShift(r: ShiftRow): RotaShift {
  return {
    id: r.id,
    clientId: r.client_id,
    siteId: r.site_id,
    staffId: r.staff_id,
    shiftDate: r.shift_date,
    startTime: r.start_time,
    endTime: r.end_time,
    role: r.role,
    status: r.status as RotaShiftStatus,
    notifiedAt: r.notified_at,
    createdAt: r.created_at,
  };
}

/** Shifts for a client within `[from, to]` (inclusive `YYYY-MM-DD` day keys). */
export async function listShifts(clientId: string, from: string, to: string): Promise<RotaShift[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("rota_shift")
    .select("*")
    .eq("client_id", clientId)
    .gte("shift_date", from)
    .lte("shift_date", to)
    .order("shift_date", { ascending: true })
    .order("start_time", { ascending: true });
  if (error) throw error;
  return (data as ShiftRow[]).map(rowToShift);
}

/**
 * Insert generated shifts, idempotently on the unique (staff_id, shift_date,
 * start_time) key: re-running generate for the same weeks never doubles a slot.
 * Returns how many rows were newly inserted (ignoreDuplicates means existing
 * rows are skipped, so this reflects genuinely new shifts).
 */
export async function insertShifts(shifts: RotaShift[]): Promise<number> {
  if (shifts.length === 0) return 0;
  const db = serviceClient();
  const rows = shifts.map((s) => ({
    client_id: s.clientId,
    site_id: s.siteId,
    staff_id: s.staffId,
    shift_date: s.shiftDate,
    start_time: s.startTime,
    end_time: s.endTime,
    role: s.role,
    status: s.status ?? "scheduled",
  }));
  const { data, error } = await db
    .from("rota_shift")
    .upsert(rows, { onConflict: "client_id,staff_id,shift_date,start_time", ignoreDuplicates: true })
    .select("id");
  if (error) throw error;
  return (data as unknown[] | null)?.length ?? 0;
}

/**
 * Scheduled (not yet notified, not cancelled) shifts starting on/after `fromDay`
 * and on/before `toDay`, for the sweep to text out. Ordered by staff then date so
 * the caller can group per person.
 */
export async function listUnnotifiedUpcoming(
  clientId: string,
  fromDay: string,
  toDay: string,
): Promise<RotaShift[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("rota_shift")
    .select("*")
    .eq("client_id", clientId)
    .eq("status", "scheduled")
    .gte("shift_date", fromDay)
    .lte("shift_date", toDay)
    .order("staff_id", { ascending: true })
    .order("shift_date", { ascending: true })
    .order("start_time", { ascending: true });
  if (error) throw error;
  return (data as ShiftRow[]).map(rowToShift);
}

/** Mark shifts as notified once the staff member has been texted (no double-send). */
export async function markNotified(shiftIds: string[]): Promise<void> {
  if (shiftIds.length === 0) return;
  const db = serviceClient();
  const { error } = await db
    .from("rota_shift")
    .update({ status: "notified", notified_at: new Date().toISOString() })
    .in("id", shiftIds);
  if (error) throw error;
}
