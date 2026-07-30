// ---------------------------------------------------------------------------
// The boundary between raw Dentally JSON and the dashboard aggregators.
//
// Every list endpoint on DentallyClient returns `unknown[]`, because the wire
// shape is theirs and not ours. This file is the single place that shape is
// interrogated. Each normaliser returns a narrow, typed row, or `null` when the
// record cannot be read well enough to be counted. Nothing downstream re-parses
// a raw field, and nothing downstream sees a NaN.
//
// The contract, everywhere: null means DROP AND COUNT, never "treat as zero".
//
// Pure functions only: no I/O, no clock reads.
// ---------------------------------------------------------------------------

import { parseMoneyPence, parseUdaHundredths } from "@/lib/dashboard/money";
import { isDayKey, londonDayOfIso } from "@/lib/dashboard/period";

/** Result of normalising a batch: the usable rows, plus how many were dropped. */
export interface NormaliseResult<T> {
  rows: T[];
  dropped: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  // Dentally ids are sometimes numeric; a number id is still a usable id.
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  return null;
}

/** Apply a normaliser across a raw list, collecting the drop count. */
function normaliseAll<T>(raw: readonly unknown[], one: (r: unknown) => T | null): NormaliseResult<T> {
  const rows: T[] = [];
  let dropped = 0;
  for (const item of raw) {
    const row = one(item);
    if (row === null) dropped += 1;
    else rows.push(row);
  }
  return { rows, dropped };
}

// --- Payments --------------------------------------------------------------

/** A payment we can safely total. */
export interface DashboardPayment {
  id: string;
  /** Whole pence. Negative for a refund, which correctly reduces takings. */
  amountPence: number;
  /** The practice's own calendar day, from Dentally's `dated_on`. */
  day: string;
  siteId: string | null;
  practitionerId: string | null;
  patientId: string | null;
  /** Dentally's soft-delete flag. Deleted payments are excluded from totals. */
  deleted: boolean;
}

/**
 * Normalise one /v1/payments record.
 *
 * `amount` arrives as a STRING ("27.9"); a malformed one drops the row rather
 * than counting as zero. `dated_on` is a bare `YYYY-MM-DD` with no time zone,
 * so it IS the practice's local day and is used as the bucket key directly.
 * Nothing here branches on `status`, whose value vocabulary is not verified
 * against the live API; only `deleted` is trusted.
 */
export function normalisePayment(raw: unknown): DashboardPayment | null {
  const r = asRecord(raw);
  if (!r) return null;
  const id = asString(r["id"]);
  if (id === null) return null;
  const amountPence = parseMoneyPence(r["amount"]);
  if (amountPence === null) return null;
  const day = r["dated_on"];
  if (!isDayKey(day)) return null;
  return {
    id,
    amountPence,
    day,
    siteId: asString(r["site_id"]),
    practitionerId: asString(r["practitioner_id"]),
    patientId: asString(r["patient_id"]),
    deleted: asBoolean(r["deleted"]) ?? false,
  };
}

export function normalisePayments(raw: readonly unknown[]): NormaliseResult<DashboardPayment> {
  return normaliseAll(raw, normalisePayment);
}

// --- Appointments ----------------------------------------------------------

/** An appointment reduced to what the donut and the day counts need. */
export interface DashboardAppointment {
  id: string;
  /** London calendar day of start_time. */
  day: string;
  siteId: string | null;
  practitionerId: string | null;
  patientId: string | null;
  /** Raw state, kept verbatim so an unrecognised one can be reported, not guessed at. */
  state: string;
}

/**
 * Normalise one /v1/appointments record. `start_time` is a full ISO instant, so
 * its day MUST come from the Europe/London calendar, never an ISO slice.
 */
export function normaliseAppointment(raw: unknown): DashboardAppointment | null {
  const r = asRecord(raw);
  if (!r) return null;
  const id = asString(r["id"]);
  if (id === null) return null;
  const day = londonDayOfIso(r["start_time"]);
  if (day === null) return null;
  return {
    id,
    day,
    siteId: asString(r["site_id"]),
    practitionerId: asString(r["practitioner_id"]),
    patientId: asString(r["patient_id"]),
    state: typeof r["state"] === "string" ? r["state"] : "",
  };
}

export function normaliseAppointments(raw: readonly unknown[]): NormaliseResult<DashboardAppointment> {
  return normaliseAll(raw, normaliseAppointment);
}

// --- Outstanding accounts --------------------------------------------------

/** One patient's balance, from an invoice or account row. */
export interface DashboardAccountBalance {
  patientId: string;
  patientName: string | null;
  /** Whole pence still owed by this patient on this row. Negative means in credit. */
  owedPence: number;
}

/**
 * Normalise one balance-bearing row (an invoice, or an account). Reads
 * `amount_outstanding` first, falling back to `outstanding` / `balance` for the
 * account shape. A row with no readable balance is dropped, never zeroed.
 */
export function normaliseAccountBalance(raw: unknown): DashboardAccountBalance | null {
  const r = asRecord(raw);
  if (!r) return null;
  const patientId = asString(r["patient_id"]);
  if (patientId === null) return null;

  const candidate = ["amount_outstanding", "outstanding", "balance"].find((k) => k in r);
  if (candidate === undefined) return null;
  const owedPence = parseMoneyPence(r[candidate]);
  if (owedPence === null) return null;

  const first = asString(r["first_name"]);
  const last = asString(r["last_name"]);
  const composed = [first, last].filter((p): p is string => p !== null).join(" ");
  const patientName = asString(r["patient_name"]) ?? (composed.length > 0 ? composed : null);

  return { patientId, patientName, owedPence };
}

export function normaliseAccountBalances(
  raw: readonly unknown[],
): NormaliseResult<DashboardAccountBalance> {
  return normaliseAll(raw, normaliseAccountBalance);
}

// --- Patients --------------------------------------------------------------

export interface DashboardPatient {
  id: string;
  siteId: string | null;
  /** London day the patient record was created, or null when the source omits it. */
  createdDay: string | null;
  /** Dentally's `active` flag, or null when the source omits it. */
  active: boolean | null;
  archived: boolean;
}

export function normalisePatient(raw: unknown): DashboardPatient | null {
  const r = asRecord(raw);
  if (!r) return null;
  const id = asString(r["id"]);
  if (id === null) return null;
  const createdRaw = r["created_at"];
  const createdDay = isDayKey(createdRaw) ? createdRaw : londonDayOfIso(createdRaw);
  return {
    id,
    siteId: asString(r["site_id"]),
    createdDay,
    active: asBoolean(r["active"]),
    archived: asBoolean(r["archived"]) ?? false,
  };
}

export function normalisePatients(raw: readonly unknown[]): NormaliseResult<DashboardPatient> {
  return normaliseAll(raw, normalisePatient);
}

// --- Treatment plans -------------------------------------------------------

export interface DashboardTreatmentPlan {
  id: string;
  siteId: string | null;
  /** London day the plan started (accepted, else created). Null when unsourceable. */
  startedDay: string | null;
  /** London day the plan finished. Null when it has not finished, or is unsourceable. */
  finishedDay: string | null;
  /**
   * Whether the source carried a finish field AT ALL (even set to null). This is
   * how "no plans finished in this window" is told apart from "this source does
   * not expose finish dates", which must read as unavailable rather than zero.
   */
  hasFinishField: boolean;
}

const FINISH_KEYS = ["completed_at", "finished_at", "completed_date"] as const;
const START_KEYS = ["accepted_at", "created_at", "started_at"] as const;

export function normaliseTreatmentPlan(raw: unknown): DashboardTreatmentPlan | null {
  const r = asRecord(raw);
  if (!r) return null;
  const id = asString(r["id"]);
  if (id === null) return null;

  let startedDay: string | null = null;
  for (const key of START_KEYS) {
    const value = r[key];
    const day = isDayKey(value) ? value : londonDayOfIso(value);
    if (day !== null) {
      startedDay = day;
      break;
    }
  }

  let finishedDay: string | null = null;
  let hasFinishField = false;
  for (const key of FINISH_KEYS) {
    if (!(key in r)) continue;
    hasFinishField = true;
    const value = r[key];
    const day = isDayKey(value) ? value : londonDayOfIso(value);
    if (day !== null) {
      finishedDay = day;
      break;
    }
  }

  return { id, siteId: asString(r["site_id"]), startedDay, finishedDay, hasFinishField };
}

export function normaliseTreatmentPlans(
  raw: readonly unknown[],
): NormaliseResult<DashboardTreatmentPlan> {
  return normaliseAll(raw, normaliseTreatmentPlan);
}

// --- NHS claims ------------------------------------------------------------

export interface DashboardNhsClaim {
  id: string;
  siteId: string | null;
  practitionerId: string | null;
  /** London day the claim was submitted. Null when the source omits it. */
  day: string | null;
  /** Whole hundredths of a UDA. */
  expectedUdaHundredths: number;
  awardedUdaHundredths: number;
  /** Raw claim_status, kept verbatim; an unrecognised one is reported, not guessed at. */
  status: string;
  band: string | null;
}

/**
 * Normalise one /v1/nhs_claims record. `expected_uda` and `awarded_uda` arrive
 * as STRINGS. `expected_uda` is required (a claim with no expected UDA cannot be
 * counted either way); `awarded_uda` is optional and defaults to 0 hundredths,
 * because a submitted-but-not-yet-awarded claim genuinely has nothing awarded.
 */
export function normaliseNhsClaim(raw: unknown): DashboardNhsClaim | null {
  const r = asRecord(raw);
  if (!r) return null;
  const id = asString(r["id"]);
  if (id === null) return null;
  const expectedUdaHundredths = parseUdaHundredths(r["expected_uda"]);
  if (expectedUdaHundredths === null) return null;
  const awardedRaw = r["awarded_uda"];
  const awardedUdaHundredths =
    awardedRaw === null || awardedRaw === undefined ? 0 : parseUdaHundredths(awardedRaw);
  if (awardedUdaHundredths === null) return null;

  const submitted = r["submitted_date"];
  const day = isDayKey(submitted) ? submitted : londonDayOfIso(submitted);

  return {
    id,
    siteId: asString(r["site_id"]),
    practitionerId: asString(r["practitioner_id"]),
    day,
    expectedUdaHundredths,
    awardedUdaHundredths,
    status: typeof r["claim_status"] === "string" ? r["claim_status"] : "",
    band: asString(r["uda_band"]),
  };
}

export function normaliseNhsClaims(raw: readonly unknown[]): NormaliseResult<DashboardNhsClaim> {
  return normaliseAll(raw, normaliseNhsClaim);
}
