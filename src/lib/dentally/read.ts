import { DentallyClient } from "./client";
import { normaliseAppointmentState } from "./appointment-state";
import { dentallySiteId, siteIdFromDentally } from "@/lib/mock/clients";

/**
 * The Dentally API key for READ / sync operations (listing patients, appointments,
 * plans, invoices; resolving a message recipient). Prefers the dedicated read-only
 * key when set, falling back to DENTALLY_API_KEY so nothing breaks before it is
 * configured.
 *
 * WRITE paths (the agent booking appointments or creating patients, in
 * src/lib/agent/tools.ts via the inbound/voice routes' own client) deliberately do
 * NOT use this: they read DENTALLY_API_KEY directly, so a read-only key can never
 * be used to attempt a write against real Dentally.
 */
export function dentallyReadKey(): string {
  return process.env.DENTALLY_PROD_READONLY_API_KEY || process.env.DENTALLY_API_KEY || "";
}

/**
 * A DentallyClient configured from the environment for READS. Points at the local
 * mock by default in the pilot (DENTALLY_BASE_URL), and at real Dentally once a key
 * and base URL are set, with no change to callers.
 */
export function dentallyFromEnv(): DentallyClient {
  return new DentallyClient({
    apiKey: dentallyReadKey(),
    baseUrl: process.env.DENTALLY_BASE_URL ?? "https://api.dentally.co",
  });
}

export interface DentallySiteRecord {
  /** The real Dentally site id (what the API expects as site_id). */
  dentallyId: string;
  name: string;
}

/** The practice's real Dentally sites (read-only GET /v1/sites). Best-effort: [] on error. */
export async function listDentallySites(): Promise<DentallySiteRecord[]> {
  const client = dentallyFromEnv();
  try {
    const res = await client.listSites();
    const rows = Array.isArray(res.sites) ? res.sites : [];
    return rows
      .map((s) => {
        const r = s as Record<string, unknown>;
        return { dentallyId: String(r.id ?? ""), name: str(r.name) ?? "" };
      })
      .filter((s) => s.dentallyId !== "");
  } catch (err) {
    console.error("[dentally] listSites failed", err);
    return [];
  }
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
/** Map a Dentally site_id from a response back to our internal site id (falls back
 *  to the raw value, which is already internal in the mock/pilot). */
function mapSite(rawSiteId: unknown): string {
  const raw = str(rawSiteId) ?? "";
  return siteIdFromDentally(raw) ?? raw;
}

function toPatient(r: Record<string, unknown>): PatientRecord {
  const first = str(r.first_name) ?? "";
  const last = str(r.last_name) ?? "";
  return {
    id: String(r.id ?? ""),
    name: `${first} ${last}`.trim() || "Unknown",
    email: str(r.email_address),
    phone: str(r.mobile_phone),
    siteId: mapSite(r.site_id),
    active: r.active !== false,
    archivedReason: str(r.archived_reason),
    recallDueAt: str(r.dentist_recall_date) ?? str(r.hygienist_recall_date),
    lastVisitAt: str(r.last_visit_at),
    dateOfBirth: str(r.date_of_birth),
    smsConsent: bool(r.use_sms),
    emailConsent: bool(r.use_email),
  };
}

// Dentally caps a list page at ~100 rows. A single unpaged call therefore silently
// truncates every list endpoint at the first 100 rows on a real-size practice — the
// reviews module 404s on almost every patient/appointment, and the co-pilot's diary
// omits most of the day, all while passing dry-run (the mock returns every fixture in
// one page). Loop pages until a short (< PER_PAGE) one, bounded by MAX_PAGES.
const PER_PAGE = 100;
const MAX_PAGES = 100; // hard bound: up to 10k rows/site/endpoint, so a bad upstream can't loop forever

async function pageAll<T>(fetchPage: (page: number) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const rows = await fetchPage(page);
    out.push(...rows);
    if (rows.length < PER_PAGE) break; // short page => last page
  }
  return out;
}

/** All patients across the given sites. */
export async function listPatients(siteIds: string[]): Promise<PatientRecord[]> {
  const client = dentallyFromEnv();
  const out: PatientRecord[] = [];
  for (const siteId of siteIds) {
    try {
      const rows = await pageAll((page) =>
        client.listPatients({ siteId: dentallySiteId(siteId), page, perPage: PER_PAGE }).then((res) => res.patients ?? []),
      );
      for (const p of rows) out.push(toPatient(p as Record<string, unknown>));
    } catch (err) {
      // Skip a site that errors, but LOG it: on live Dentally a 500/timeout/rate-limit
      // here is otherwise indistinguishable from a genuinely empty site and silently
      // drops the whole site's data.
      console.error(`[dentally] listPatients failed for site ${siteId}; skipping this site`, err);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** One patient by id via the direct Dentally read (`GET /v1/patients/:id`), NOT a
 *  full-list scan. Returns null if the patient is not found or the read errors — so a
 *  caller resolving a single patient (e.g. reviews attend) never has to page the whole
 *  patient list and never 404s a patient just because they sit past page 1. */
export async function getPatientById(patientId: string): Promise<PatientRecord | null> {
  const client = dentallyFromEnv();
  try {
    const res = await client.getPatient(patientId);
    const p = res.patient;
    if (!p || typeof p !== "object") return null;
    return toPatient(p as Record<string, unknown>);
  } catch (err) {
    console.error(`[dentally] getPatient(${patientId}) failed`, err);
    return null;
  }
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
    // Canonicalised: real Dentally sends "Did not attend" / "In surgery" etc.;
    // downstream sets (diary gaps, brief gap count) compare did_not_attend-style.
    state: normaliseAppointmentState(r.state),
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
      const rows = await pageAll((page) =>
        client
          .listAppointments({ siteId: dentallySiteId(siteId), fromDate: range?.from, toDate: range?.to, page, perPage: PER_PAGE })
          .then((res) => res.appointments ?? []),
      );
      for (const a of rows) out.push(toAppointment(a as Record<string, unknown>, siteId));
    } catch (err) {
      console.error(`[dentally] listAppointments failed for site ${siteId}; skipping this site`, err);
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

  const plansP = pageAll((page) =>
    client.listTreatmentPlans({ siteId: dentallySiteId(siteId), page, perPage: PER_PAGE }).then((res) => res.treatment_plans ?? []),
  )
    .then((plans) =>
      plans
        .map((pl) => pl as Record<string, unknown>)
        .filter((r) => String(r.patient_id ?? "") === patientId)
        .map<PlanRecord>((r) => ({
          // Real Dentally plan fields: nickname (often null) for the label, and
          // private_treatment_value for the £ value (NHS plans carry UDAs, not £).
          name: str(r.nickname) ?? str(r.name) ?? "Treatment plan",
          planned: num(r.private_treatment_value ?? r.planned_private_treatment_value),
          // amount_outstanding is not on the plan (it lives on invoices/accounts).
          outstanding: num(r.amount_outstanding),
          acceptedAt: str(r.start_date) ?? str(r.accepted_at) ?? str(r.created_at),
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
      const plans = await pageAll((page) =>
        client.listTreatmentPlans({ siteId: dentallySiteId(siteId), page, perPage: PER_PAGE }).then((res) => res.treatment_plans ?? []),
      );
      for (const pl of plans) {
        const r = pl as Record<string, unknown>;
        // NOTE: real Dentally plans do NOT carry amount_outstanding (it lives on
        // invoices/accounts). Until an invoice-based outstanding lookup is added,
        // this yields no rows on live data — the Payments module needs that pass.
        const outstanding = num(r.amount_outstanding);
        if (outstanding <= 0) continue;
        const patientId = String(r.patient_id ?? "");
        out.push({
          patientId,
          patientName: nameById.get(patientId) ?? "Patient",
          siteId: mapSite(r.site_id) || siteId,
          planName: str(r.nickname) ?? str(r.name) ?? "Treatment plan",
          planned: num(r.private_treatment_value ?? r.planned_private_treatment_value),
          outstanding,
          acceptedAt: str(r.start_date) ?? str(r.accepted_at),
        });
      }
    } catch (err) {
      console.error(`[dentally] listTreatmentPlans failed for site ${siteId}; skipping this site`, err);
    }
  }
  return out.sort((a, b) => b.outstanding - a.outstanding);
}
