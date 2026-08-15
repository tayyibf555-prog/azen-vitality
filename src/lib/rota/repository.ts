import { serviceClient } from "@/lib/supabase/server";
import { DEFAULT_ROTA_CONFIG, normaliseConfig } from "./config";
import type { PublicationSnapshot } from "./publish";
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

export async function listStaff(
  clientId: string,
  opts?: { activeOnly?: boolean; siteIds?: string[] },
): Promise<RotaStaff[]> {
  const db = serviceClient();
  let q = db.from("rota_staff").select("*").eq("client_id", clientId);
  if (opts?.activeOnly) q = q.eq("active", true);
  // Site scope: when a specific site (or set) is selected, show staff assigned to it
  // PLUS "any site" floating staff (site_id null, who work across sites). An all-sites
  // view passes no siteIds and sees everyone. Ids are safe (site-cc etc., no commas).
  if (opts?.siteIds && opts.siteIds.length > 0) {
    q = q.or(`site_id.in.(${opts.siteIds.join(",")}),site_id.is.null`);
  }
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
  // Added by 0074. Optional on the row type ON PURPOSE: `select("*")` against a
  // database that has not run 0074 yet simply does not return them, and a row type
  // that insisted on their presence would turn a missing column into a type lie.
  origin?: string | null;
  paired_staff_id?: string | null;
  note?: string | null;
  published_at?: string | null;
  published_version?: number | null;
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
    // A row from before 0074 has no origin, and "the machine made it" is the only
    // thing it could have been: manual editing did not exist.
    origin: r.origin === "manual" ? "manual" : "generated",
    pairedStaffId: r.paired_staff_id ?? null,
    note: r.note ?? null,
    publishedAt: r.published_at ?? null,
    publishedVersion: r.published_version ?? null,
  };
}

export interface ListShiftsOptions {
  /** Limit to these sites. Omit for every site the client has. */
  siteIds?: string[];
  /**
   * Limit to these statuses. Omit to return EVERYTHING, tombstones included.
   *
   * The default is deliberately everything: the generator needs to see the
   * tombstones (they are the record of what a person deleted) and so does the
   * editing grid, which greys them rather than pretending they never existed.
   */
  statuses?: RotaShiftStatus[];
  /**
   * Limit to these staff members. THE SELF-SERVICE NARROWING, applied at the
   * query so a self-service caller's request never loads the rest of the team's
   * week and then filters it in the response.
   */
  staffIds?: string[];
  /**
   * Only shifts that have been PUBLISHED — a `published_at` stamp is present.
   *
   * A draft rota is a manager thinking out loud, and showing one to the person who
   * would have to turn up for it is worse than showing no rota at all. The same
   * rule is enforced again in `@/lib/my-work/rules` where the rows are rendered;
   * this is the half that keeps the drafts out of the response in the first place.
   */
  publishedOnly?: boolean;
}

/**
 * "This column does not exist yet" — the publish columns arrive with 0074, and
 * `42703` is Postgres's undefined_column (the clock repository's note on 0068).
 */
function isMissingPublishColumn(error: { code?: string } | null): boolean {
  return error?.code === "42703" || error?.code === "42P01";
}

/** Shifts for a client within `[from, to]` (inclusive `YYYY-MM-DD` day keys). */
export async function listShifts(
  clientId: string,
  from: string,
  to: string,
  opts?: ListShiftsOptions,
): Promise<RotaShift[]> {
  const db = serviceClient();
  let q = db
    .from("rota_shift")
    .select("*")
    .eq("client_id", clientId)
    .gte("shift_date", from)
    .lte("shift_date", to);
  if (opts?.siteIds && opts.siteIds.length > 0) q = q.in("site_id", opts.siteIds);
  if (opts?.statuses && opts.statuses.length > 0) q = q.in("status", opts.statuses);
  if (opts?.staffIds && opts.staffIds.length > 0) q = q.in("staff_id", opts.staffIds);
  if (opts?.publishedOnly) q = q.not("published_at", "is", null);
  const { data, error } = await q
    .order("shift_date", { ascending: true })
    .order("start_time", { ascending: true });
  if (error) {
    // Before 0074 there is no `published_at` column, so a published-only read
    // cannot be answered. NOTHING has been published in that state — publishing
    // did not exist — so the honest answer is an empty list, and the alternative
    // (dropping the filter and returning the drafts) is the one thing this option
    // exists to prevent. Only ever taken for a published-only read: every other
    // caller still gets the error.
    if (opts?.publishedOnly && isMissingPublishColumn(error)) return [];
    throw error;
  }
  return (data as ShiftRow[]).map(rowToShift);
}

/** One shift, scoped to the caller's client so a foreign id reads as absent. */
export async function getShift(id: string, clientId: string): Promise<RotaShift | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("rota_shift")
    .select("*")
    .eq("id", id)
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToShift(data as ShiftRow) : null;
}

export interface CreateManualShiftInput {
  clientId: string;
  siteId: string;
  staffId: string;
  shiftDate: string;
  startTime: string;
  endTime: string;
  role: string;
  pairedStaffId?: string | null;
  note?: string | null;
}

/**
 * Add a shift a person decided on.
 *
 * Always `origin='manual'`, which is what protects it from the generator. If the
 * slot already carries a tombstone (the manager deleted it and has now changed
 * their mind) the unique key would collide, so this UPSERTS onto the same key and
 * brings the row back as a live manual shift rather than answering "duplicate" to
 * somebody who is looking at an empty square.
 */
export async function createManualShift(input: CreateManualShiftInput): Promise<RotaShift> {
  const db = serviceClient();
  const { data, error } = await db
    .from("rota_shift")
    .upsert(
      {
        client_id: input.clientId,
        site_id: input.siteId,
        staff_id: input.staffId,
        shift_date: input.shiftDate,
        start_time: input.startTime,
        end_time: input.endTime,
        role: input.role,
        status: "scheduled",
        origin: "manual",
        paired_staff_id: input.pairedStaffId ?? null,
        note: input.note ?? null,
        // Re-using a tombstoned slot starts a fresh promise: whatever was published
        // about the old shift is no longer what this one says.
        notified_at: null,
        published_at: null,
        published_version: null,
      },
      { onConflict: "client_id,staff_id,shift_date,start_time" },
    )
    .select("*")
    .single();
  if (error) throw error;
  return rowToShift(data as ShiftRow);
}

export interface UpdateShiftInput {
  siteId?: string;
  staffId?: string;
  shiftDate?: string;
  startTime?: string;
  endTime?: string;
  role?: string;
  pairedStaffId?: string | null;
  note?: string | null;
}

/**
 * Move or amend a shift.
 *
 * ALWAYS flips `origin` to 'manual', including on a row the generator created. That
 * is the rule that makes an edit stick (`originAfterEdit` states it, under test): a
 * moved shift that stayed 'generated' would be re-derived from the config and moved
 * straight back on the next run.
 *
 * Returns true when a row matched; false for an unknown id or one owned by another
 * client, so the API can answer 404 rather than a misleading {ok:true}.
 */
export async function updateShift(
  id: string,
  clientId: string,
  fields: UpdateShiftInput,
  /**
   * True when the edit invalidates what the staff member was already told, decided
   * by `notificationIsStale` in `./edit`. Resetting the status is what puts the
   * shift back in front of the 24/7 sweep so the CORRECTION goes out; without it a
   * shift texted on Monday and moved on Tuesday is never mentioned again.
   */
  resetNotification = false,
): Promise<boolean> {
  const patch: Record<string, unknown> = { origin: "manual" };
  if (resetNotification) {
    patch.status = "scheduled";
    patch.notified_at = null;
  }
  if (fields.siteId !== undefined) patch.site_id = fields.siteId;
  if (fields.staffId !== undefined) patch.staff_id = fields.staffId;
  if (fields.shiftDate !== undefined) patch.shift_date = fields.shiftDate;
  if (fields.startTime !== undefined) patch.start_time = fields.startTime;
  if (fields.endTime !== undefined) patch.end_time = fields.endTime;
  if (fields.role !== undefined) patch.role = fields.role;
  if (fields.pairedStaffId !== undefined) patch.paired_staff_id = fields.pairedStaffId;
  if (fields.note !== undefined) patch.note = fields.note;

  const db = serviceClient();
  const { data, error } = await db
    .from("rota_shift")
    .update(patch)
    .eq("id", id)
    .eq("client_id", clientId) // scope the write to the caller's client
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

/**
 * Delete a shift, as a TOMBSTONE.
 *
 * Never a hard delete, and that is the whole point: a deleted row is
 * indistinguishable from a slot that was never generated, so the next run of the
 * generator puts the shift straight back. `status='removed'` is the record that a
 * person decided this shift should not happen, and `generateShifts` both refuses to
 * re-create it and counts it as coverage so no replacement is invented either.
 *
 * `origin` is set to 'manual' alongside, because a deletion is a human decision
 * exactly as much as a move is.
 */
export async function tombstoneShift(id: string, clientId: string): Promise<boolean> {
  const db = serviceClient();
  const { data, error } = await db
    .from("rota_shift")
    .update({ status: "removed", origin: "manual" })
    .eq("id", id)
    .eq("client_id", clientId)
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

// PAIRING IS MANUAL, and there is no bulk writer for it on purpose.
//
// A `pairedStaffId` is set by a person in the shift dialog and written by
// `createManualShift` / `updateShift`, which validate it through
// `validateShiftEdit`. An `autoPair` engine and a `setPairings` bulk writer were
// built alongside those and never wired to anything; they are gone rather than
// left in the tree, because a reader who finds them cannot tell whether pairing
// is automatic or manual. `pairingViolations` in lib/rota/edit.ts is what
// actually tells the manager an unpaired clinician is on the day.

/**
 * Insert generated shifts, idempotently on the unique (staff_id, shift_date,
 * start_time) key: re-running generate for the same weeks never doubles a slot.
 * Returns how many rows were newly inserted (ignoreDuplicates means existing
 * rows are skipped, so this reflects genuinely new shifts).
 *
 * `origin` is DELIBERATELY not in the payload. The generator only ever creates
 * generated shifts, so the column default ('generated', 0074) says exactly the right
 * thing, and leaving it out means this insert keeps working on a database that has
 * not run 0074 yet. The 24/7 sweep calls this; it must not be the thing that breaks
 * if the migration and the deploy land in the wrong order.
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

// ---------------------------------------------------------------------------
// Publications.
// ---------------------------------------------------------------------------

interface PublicationRow {
  id: string;
  client_id: string;
  site_id: string | null;
  week_start: string;
  version: number;
  published_by: string | null;
  published_at: string;
  shift_count: number;
  snapshot: unknown;
  notified_count: number;
  simulated_count: number;
}

export interface RotaPublication {
  id: string;
  clientId: string;
  siteId: string | null;
  weekStart: string;
  version: number;
  publishedBy: string | null;
  publishedAt: string;
  shiftCount: number;
  snapshot: PublicationSnapshot;
  notifiedCount: number;
  simulatedCount: number;
}

function rowToPublication(r: PublicationRow): RotaPublication {
  return {
    id: r.id,
    clientId: r.client_id,
    siteId: r.site_id,
    weekStart: r.week_start,
    version: r.version,
    publishedBy: r.published_by,
    publishedAt: r.published_at,
    shiftCount: r.shift_count,
    snapshot: r.snapshot as PublicationSnapshot,
    notifiedCount: r.notified_count,
    simulatedCount: r.simulated_count ?? 0,
  };
}

/**
 * Every publication of one week, newest version first.
 *
 * `siteId` is matched EXACTLY, null included: publishing "all sites" and publishing
 * "site A" are two different promises to two different audiences, and diffing one
 * against the other would report changes nobody made.
 */
export async function listPublications(
  clientId: string,
  weekStart: string,
  siteId: string | null,
): Promise<RotaPublication[]> {
  const db = serviceClient();
  let q = db
    .from("rota_publication")
    .select("*")
    .eq("client_id", clientId)
    .eq("week_start", weekStart);
  q = siteId === null ? q.is("site_id", null) : q.eq("site_id", siteId);
  const { data, error } = await q.order("version", { ascending: false });
  if (error) throw error;
  return (data as PublicationRow[]).map(rowToPublication);
}

export interface RecordPublicationInput {
  clientId: string;
  siteId: string | null;
  weekStart: string;
  version: number;
  publishedBy: string | null;
  shiftCount: number;
  snapshot: PublicationSnapshot;
  notifiedCount: number;
  simulatedCount: number;
}

/**
 * Write the publication row.
 *
 * A plain INSERT, never an upsert: the unique (client, site, week, version) key is
 * what stops two people publishing the same version at once and one of them
 * silently overwriting the other's snapshot. A collision surfaces as an error the
 * route turns into "somebody else just published this week, reload and try again",
 * which is the truth.
 */
export async function recordPublication(input: RecordPublicationInput): Promise<RotaPublication> {
  const db = serviceClient();
  const { data, error } = await db
    .from("rota_publication")
    .insert({
      client_id: input.clientId,
      site_id: input.siteId,
      week_start: input.weekStart,
      version: input.version,
      published_by: input.publishedBy,
      shift_count: input.shiftCount,
      snapshot: input.snapshot,
      notified_count: input.notifiedCount,
      simulated_count: input.simulatedCount,
    })
    .select("*")
    .single();
  if (error) throw error;
  return rowToPublication(data as PublicationRow);
}

/** Stamp the published version onto the shifts it contained. */
export async function markPublished(
  clientId: string,
  shiftIds: string[],
  version: number,
  publishedAt: string,
): Promise<void> {
  if (shiftIds.length === 0) return;
  const db = serviceClient();
  const { error } = await db
    .from("rota_shift")
    .update({ published_at: publishedAt, published_version: version })
    .eq("client_id", clientId)
    .in("id", shiftIds);
  if (error) throw error;
}
