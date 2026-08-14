import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import type { HrAddress, HrEmergencyContact, StaffHrProfile, StaffPayRate } from "./types";

// ===========================================================================
// public.staff_hr_profile and public.staff_pay_rate -- server-only (service role).
//
// TWO RULES THIS FILE ENFORCES, BOTH OF THEM SCHEMA DECISIONS FROM 0075:
//
//   1. PAY IS ONLY EVER READ BY A FUNCTION THAT SAYS SO. There is no
//      `listStaffWithEverything`. A caller that wants rates asks `listPayRates`,
//      and every call site of that is guarded by `requirePayAccess`. That is why
//      pay is a separate table: `listStaff` does `select("*")` on rota_staff and
//      two endpoints return the result wholesale to the browser, so a rate
//      COLUMN would have shipped itself.
//
//   2. RATES ARE APPENDED. `appendPayRate` inserts; there is no update and no
//      delete. A pay rise is a new effective-dated row, so the month report can
//      price each day at the rate that was actually in force on it.
//
// Every read and write is scoped by client_id, and the composite FK on
// (client_id, staff_id) means the database refuses a cross-tenant staff id even
// if a guard above ever missed one.
//
// A MISSING TABLE IS NOT AN EMPTY FILE. Reads return `ready: false` while 0075 is
// unapplied so the screen can say "Staff HR is not set up on this database yet";
// rendering an empty employee file as though the practice had recorded nothing is
// exactly the confident-empty-state failure this codebase refuses.
// ===========================================================================

/** "this table/column does not exist yet", the 0075-unapplied state. */
export function isMissingRelation(error: { code?: string } | null): boolean {
  return error?.code === "42P01" || error?.code === "42703";
}

interface ProfileRow {
  client_id: string;
  staff_id: string;
  date_of_birth: string | null;
  personal_email: string | null;
  personal_phone: string | null;
  address: Record<string, unknown> | null;
  emergency_contact: Record<string, unknown> | null;
  employment_start: string | null;
  employment_end: string | null;
  contracted_days_per_week: number | string | null;
  entitlement_days_override: number | string | null;
  leave_year_start_month: number | null;
  gdc_number: string | null;
  ni_number_last4: string | null;
  updated_at: string | null;
}

/** numeric(3,1) comes back as a string from PostgREST; make it a number or null. */
function num(value: number | string | null): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function toAddress(raw: Record<string, unknown> | null): HrAddress | null {
  if (!raw || typeof raw !== "object") return null;
  return {
    line1: text(raw.line1),
    line2: text(raw.line2),
    town: text(raw.town),
    postcode: text(raw.postcode),
  };
}

function toEmergency(raw: Record<string, unknown> | null): HrEmergencyContact | null {
  if (!raw || typeof raw !== "object") return null;
  return {
    name: text(raw.name),
    relationship: text(raw.relationship),
    phone: text(raw.phone),
  };
}

function rowToProfile(r: ProfileRow): StaffHrProfile {
  return {
    staffId: r.staff_id,
    dateOfBirth: r.date_of_birth,
    personalEmail: r.personal_email,
    personalPhone: r.personal_phone,
    address: toAddress(r.address),
    emergencyContact: toEmergency(r.emergency_contact),
    employmentStart: r.employment_start,
    employmentEnd: r.employment_end,
    contractedDaysPerWeek: num(r.contracted_days_per_week),
    entitlementDaysOverride: num(r.entitlement_days_override),
    leaveYearStartMonth: r.leave_year_start_month ?? 4,
    gdcNumber: r.gdc_number,
    niNumberLast4: r.ni_number_last4,
    updatedAt: r.updated_at,
  };
}

/** Every HR profile for a client, keyed by staff id. */
export async function listHrProfiles(
  clientId: string,
  staffIds?: string[],
): Promise<{ ready: boolean; profiles: Map<string, StaffHrProfile> }> {
  if (staffIds && staffIds.length === 0) return { ready: true, profiles: new Map() };

  const db = serviceClient();
  let q = db.from("staff_hr_profile").select("*").eq("client_id", clientId);
  if (staffIds) q = q.in("staff_id", staffIds);

  const { data, error } = await q;
  if (error) {
    if (isMissingRelation(error)) return { ready: false, profiles: new Map() };
    throw error;
  }
  const profiles = new Map<string, StaffHrProfile>();
  for (const row of data as ProfileRow[]) profiles.set(row.staff_id, rowToProfile(row));
  return { ready: true, profiles };
}

export interface UpsertHrProfileInput {
  dateOfBirth?: string | null;
  personalEmail?: string | null;
  personalPhone?: string | null;
  address?: HrAddress | null;
  emergencyContact?: HrEmergencyContact | null;
  employmentStart?: string | null;
  employmentEnd?: string | null;
  contractedDaysPerWeek?: number | null;
  entitlementDaysOverride?: number | null;
  leaveYearStartMonth?: number | null;
  gdcNumber?: string | null;
  niNumberLast4?: string | null;
}

/**
 * Write one person's HR file, creating it if there is not one yet.
 *
 * Only the keys PRESENT on the input are written: an edit of the emergency
 * contact must not blank a date of birth the form did not carry. The composite
 * primary key (client_id, staff_id) is the conflict target.
 */
export async function upsertHrProfile(
  clientId: string,
  staffId: string,
  fields: UpsertHrProfileInput,
  updatedBy: string | null,
): Promise<StaffHrProfile> {
  const patch: Record<string, unknown> = {
    client_id: clientId,
    staff_id: staffId,
    updated_by: updatedBy,
    updated_at: new Date().toISOString(),
  };
  if (fields.dateOfBirth !== undefined) patch.date_of_birth = fields.dateOfBirth;
  if (fields.personalEmail !== undefined) patch.personal_email = fields.personalEmail;
  if (fields.personalPhone !== undefined) patch.personal_phone = fields.personalPhone;
  if (fields.address !== undefined) patch.address = fields.address;
  if (fields.emergencyContact !== undefined) patch.emergency_contact = fields.emergencyContact;
  if (fields.employmentStart !== undefined) patch.employment_start = fields.employmentStart;
  if (fields.employmentEnd !== undefined) patch.employment_end = fields.employmentEnd;
  if (fields.contractedDaysPerWeek !== undefined) patch.contracted_days_per_week = fields.contractedDaysPerWeek;
  if (fields.entitlementDaysOverride !== undefined) patch.entitlement_days_override = fields.entitlementDaysOverride;
  if (fields.leaveYearStartMonth !== undefined && fields.leaveYearStartMonth !== null) {
    patch.leave_year_start_month = fields.leaveYearStartMonth;
  }
  if (fields.gdcNumber !== undefined) patch.gdc_number = fields.gdcNumber;
  if (fields.niNumberLast4 !== undefined) patch.ni_number_last4 = fields.niNumberLast4;

  const db = serviceClient();
  const { data, error } = await db
    .from("staff_hr_profile")
    .upsert(patch, { onConflict: "client_id,staff_id" })
    .select("*")
    .single();
  if (error) throw error;
  return rowToProfile(data as ProfileRow);
}

interface RateRow {
  id: string;
  client_id: string;
  staff_id: string;
  hourly_pence: number;
  effective_from: string;
  effective_to: string | null;
  note: string | null;
  created_at: string | null;
}

function rowToRate(r: RateRow): StaffPayRate {
  return {
    id: r.id,
    staffId: r.staff_id,
    hourlyPence: r.hourly_pence,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
    note: r.note,
    createdAt: r.created_at,
  };
}

/**
 * Pay rates for a client's staff, newest effective date first.
 *
 * EVERY CALL SITE OF THIS IS BEHIND `requirePayAccess`. There is deliberately no
 * convenience wrapper that folds rates into a staff list, because that wrapper
 * is how pay ends up in a response nobody re-read.
 */
export async function listPayRates(
  clientId: string,
  staffIds?: string[],
): Promise<{ ready: boolean; rates: StaffPayRate[] }> {
  if (staffIds && staffIds.length === 0) return { ready: true, rates: [] };

  const db = serviceClient();
  let q = db.from("staff_pay_rate").select("*").eq("client_id", clientId);
  if (staffIds) q = q.in("staff_id", staffIds);

  const { data, error } = await q.order("effective_from", { ascending: false });
  if (error) {
    if (isMissingRelation(error)) return { ready: false, rates: [] };
    throw error;
  }
  return { ready: true, rates: (data as RateRow[]).map(rowToRate) };
}

export interface AppendPayRateInput {
  clientId: string;
  staffId: string;
  /** Integer pence per hour. */
  hourlyPence: number;
  effectiveFrom: string;
  effectiveTo?: string | null;
  note?: string | null;
  setBy: string | null;
}

/**
 * Record a rate. THE ONLY WRITE, and it is an INSERT.
 *
 * There is no update and no delete on purpose. Correcting a rate means recording
 * the correct one from a date; changing the old row in place would silently
 * re-price every hour already worked under it, and the figure somebody was
 * actually paid would be gone. The unique index on
 * (client_id, staff_id, effective_from) means a second rate starting on the same
 * day is refused by the database rather than resolved by row order.
 */
export async function appendPayRate(input: AppendPayRateInput): Promise<StaffPayRate> {
  const db = serviceClient();
  const { data, error } = await db
    .from("staff_pay_rate")
    .insert({
      client_id: input.clientId,
      staff_id: input.staffId,
      hourly_pence: Math.round(input.hourlyPence),
      effective_from: input.effectiveFrom,
      effective_to: input.effectiveTo ?? null,
      note: input.note ?? null,
      set_by: input.setBy,
    })
    .select("*")
    .single();
  if (error) throw error;
  return rowToRate(data as RateRow);
}
