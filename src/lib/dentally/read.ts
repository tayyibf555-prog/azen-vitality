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
  dateOfBirth: string | null;
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
    dateOfBirth: str(r.date_of_birth),
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

function toAppointment(r: Record<string, unknown>, fallbackSiteId: string): AppointmentRecord {
  return {
    id: String(r.id ?? ""),
    patientId: String(r.patient_id ?? ""),
    patientName: str(r.patient_name) ?? "Patient",
    siteId: str(r.site_id) ?? fallbackSiteId,
    start: str(r.start_time) ?? "",
    finish: str(r.finish_time),
    durationMin: num(r.duration) || 30,
    state: str(r.state) ?? "booked",
    reason: str(r.reason),
    practitioner: str(r.practitioner),
  };
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
      for (const a of res.appointments ?? []) out.push(toAppointment(a as Record<string, unknown>, siteId));
    } catch {
      // skip
    }
  }
  return out.sort((a, b) => (a.start < b.start ? -1 : 1));
}

export interface PlanRecord {
  name: string;
  planned: number;
  outstanding: number;
  acceptedAt: string | null;
}

export interface NoteRecord {
  id: string;
  body: string;
  author: string;
  createdAt: string;
}

export interface PatientDetail {
  appointments: AppointmentRecord[];
  plans: PlanRecord[];
  notes: NoteRecord[];
  lifetimeSpend: number;
}

/** Full record for one patient: appointment history, treatment plans, notes, lifetime spend. */
export async function getPatientDetail(patientId: string, siteId: string): Promise<PatientDetail> {
  const client = dentallyFromEnv();

  const apptsP = client
    .getPatientAppointments(patientId)
    .then((res) => (res.appointments ?? []).map((a) => toAppointment(a as Record<string, unknown>, siteId)))
    .catch(() => [] as AppointmentRecord[]);

  const plansP = client
    .listTreatmentPlans({ siteId })
    .then((res) =>
      (res.treatment_plans ?? [])
        .map((pl) => pl as Record<string, unknown>)
        .filter((r) => String(r.patient_id ?? "") === patientId)
        .map<PlanRecord>((r) => ({
          name: str(r.name) ?? "Treatment plan",
          planned: num(r.planned_private_treatment_value),
          outstanding: num(r.amount_outstanding),
          acceptedAt: str(r.accepted_at),
        })),
    )
    .catch(() => [] as PlanRecord[]);

  const notesP = client
    .getPatientNotes(patientId)
    .then((res) =>
      (res.patient_notes ?? []).map((n) => {
        const r = n as Record<string, unknown>;
        return {
          id: String(r.id ?? ""),
          body: str(r.body) ?? "",
          author: str(r.author) ?? "Team",
          createdAt: str(r.created_at) ?? "",
        };
      }),
    )
    .catch(() => [] as NoteRecord[]);

  const spendP = client
    .getPatientInvoices(patientId)
    .then((res) =>
      (res.invoices ?? []).reduce<number>((sum, inv) => sum + num((inv as Record<string, unknown>).paid), 0),
    )
    .catch(() => 0);

  const [appointments, plans, notes, lifetimeSpend] = await Promise.all([apptsP, plansP, notesP, spendP]);
  appointments.sort((a, b) => (a.start < b.start ? 1 : -1)); // newest first
  return { appointments, plans, notes, lifetimeSpend };
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
