import { DentallyClient } from "./client";

/**
 * A DentallyClient configured from the environment. Points at the local mock by
 * default in the pilot (DENTALLY_BASE_URL), and at real Dentally once a key and
 * base URL are set, with no change to callers.
 */
export function dentallyFromEnv(): DentallyClient {
  return new DentallyClient({
    apiKey: process.env.DENTALLY_API_KEY ?? "",
    baseUrl: process.env.DENTALLY_BASE_URL ?? "https://api.dentally.co",
  });
}

export interface PatientRecord {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  siteId: string;
  active: boolean;
  archivedReason: string | null;
  recallDueAt: string | null;
  lastVisitAt: string | null;
  smsConsent: boolean;
  emailConsent: boolean;
}

export interface AppointmentRecord {
  id: string;
  patientId: string;
  patientName: string;
  siteId: string;
  start: string;
  finish: string | null;
  durationMin: number;
  state: string;
  reason: string | null;
  practitioner: string | null;
}

export interface OutstandingRecord {
  patientId: string;
  patientName: string;
  siteId: string;
  planName: string;
  planned: number;
  outstanding: number;
  acceptedAt: string | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v) || 0;
}
function bool(v: unknown): boolean {
  return v === true || v === 1 || v === "true";
}

function toPatient(r: Record<string, unknown>): PatientRecord {
  const first = str(r.first_name) ?? "";
  const last = str(r.last_name) ?? "";
  return {
    id: String(r.id ?? ""),
    name: `${first} ${last}`.trim() || "Unknown",
    email: str(r.email_address),
    phone: str(r.mobile_phone),
    siteId: str(r.site_id) ?? "",
    active: r.active !== false,
    archivedReason: str(r.archived_reason),
    recallDueAt: str(r.dentist_recall_date) ?? str(r.hygienist_recall_date),
    lastVisitAt: str(r.last_visit_at),
    smsConsent: bool(r.use_sms),
    emailConsent: bool(r.use_email),
  };
}

/** All patients across the given sites. */
export async function listPatients(siteIds: string[]): Promise<PatientRecord[]> {
  const client = dentallyFromEnv();
  const out: PatientRecord[] = [];
  for (const siteId of siteIds) {
    try {
      const res = await client.listPatients({ siteId });
      for (const p of res.patients ?? []) out.push(toPatient(p as Record<string, unknown>));
    } catch {
      // a site that errors is skipped, not fatal
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Appointments across the given sites, optionally within an inclusive date range. */
export async function listAppointments(
  siteIds: string[],
  range?: { from?: string; to?: string },
): Promise<AppointmentRecord[]> {
  const client = dentallyFromEnv();
  const out: AppointmentRecord[] = [];
  for (const siteId of siteIds) {
    try {
      const res = await client.listAppointments({ siteId, fromDate: range?.from, toDate: range?.to });
      for (const a of res.appointments ?? []) {
        const r = a as Record<string, unknown>;
        out.push({
          id: String(r.id ?? ""),
          patientId: String(r.patient_id ?? ""),
          patientName: str(r.patient_name) ?? "Patient",
          siteId: str(r.site_id) ?? siteId,
          start: str(r.start_time) ?? "",
          finish: str(r.finish_time),
          durationMin: num(r.duration) || 30,
          state: str(r.state) ?? "booked",
          reason: str(r.reason),
          practitioner: str(r.practitioner),
        });
      }
    } catch {
      // skip
    }
  }
  return out.sort((a, b) => (a.start < b.start ? -1 : 1));
}

/** Treatment plans with money still outstanding, across the given sites, with patient names. */
export async function listOutstanding(siteIds: string[]): Promise<OutstandingRecord[]> {
  const client = dentallyFromEnv();
  const patients = await listPatients(siteIds);
  const nameById = new Map(patients.map((p) => [p.id, p.name]));
  const out: OutstandingRecord[] = [];
  for (const siteId of siteIds) {
    try {
      const res = await client.listTreatmentPlans({ siteId });
      for (const pl of res.treatment_plans ?? []) {
        const r = pl as Record<string, unknown>;
        const outstanding = num(r.amount_outstanding);
        if (outstanding <= 0) continue;
        const patientId = String(r.patient_id ?? "");
        out.push({
          patientId,
          patientName: nameById.get(patientId) ?? "Patient",
          siteId: str(r.site_id) ?? siteId,
          planName: str(r.name) ?? "Treatment plan",
          planned: num(r.planned_private_treatment_value),
          outstanding,
          acceptedAt: str(r.accepted_at),
        });
      }
    } catch {
      // skip
    }
  }
  return out.sort((a, b) => b.outstanding - a.outstanding);
}
