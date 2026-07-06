import { cache } from "react";
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

/** All patients across the given sites. The 3 sites are paged CONCURRENTLY (peak
 *  concurrency = site count), so wall-clock is the slowest single site, not the sum.
 *  /v1/patients DOES honour site_id server-side, so this stays a per-site scan. */
export async function listPatients(siteIds: string[]): Promise<PatientRecord[]> {
  const client = dentallyFromEnv();
  const perSite = await Promise.all(
    siteIds.map(async (siteId) => {
      try {
        const rows = await pageAll((page) =>
          client.listPatients({ siteId: dentallySiteId(siteId), page, perPage: PER_PAGE }).then((res) => res.patients ?? []),
        );
        return rows.map((p) => toPatient(p as Record<string, unknown>));
      } catch (err) {
        // Skip a site that errors, but LOG it: on live Dentally a 500/timeout/rate-limit
        // here is otherwise indistinguishable from a genuinely empty site and silently
        // drops the whole site's data.
        console.error(`[dentally] listPatients failed for site ${siteId}; skipping this site`, err);
        return [] as PatientRecord[];
      }
    }),
  );
  return perSite.flat().sort((a, b) => a.name.localeCompare(b.name));
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

/**
 * Appointments across the given sites, optionally within an inclusive date range.
 *
 * Wrapped in React cache() keyed on PRIMITIVE args (sites joined + the window), so
 * the same window requested several times in one render — the Home page fetches
 * today thrice: the brief's diary section, its arriving-value section, and the
 * diary rail — collapses to a SINGLE upstream fetch. Sites are paged concurrently.
 * cache() is request-scoped only: zero cross-request staleness.
 */
const listAppointmentsCached = cache(
  async (siteKey: string, from: string, to: string): Promise<AppointmentRecord[]> => {
    const siteIds = siteKey.split("|").filter(Boolean);
    const client = dentallyFromEnv();
    const perSite = await Promise.all(
      siteIds.map(async (siteId) => {
        try {
          const rows = await pageAll((page) =>
            client
              .listAppointments({ siteId: dentallySiteId(siteId), fromDate: from || undefined, toDate: to || undefined, page, perPage: PER_PAGE })
              .then((res) => res.appointments ?? []),
          );
          return rows.map((a) => toAppointment(a as Record<string, unknown>, siteId));
        } catch (err) {
          console.error(`[dentally] listAppointments failed for site ${siteId}; skipping this site`, err);
          return [] as AppointmentRecord[];
        }
      }),
    );
    return perSite.flat();
  },
);

export async function listAppointments(
  siteIds: string[],
  range?: { from?: string; to?: string },
): Promise<AppointmentRecord[]> {
  const out = [...(await listAppointmentsCached(siteIds.join("|"), range?.from ?? "", range?.to ?? ""))];
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

  // 1. Scan treatment_plans ONCE. Real Dentally IGNORES the site_id filter and
  //    returns the entire (5-practice) group's plans on every site call, so the old
  //    per-site loop paged the identical firehose 3x. Dedup by plan id and stop as
  //    soon as a later site's first page adds nothing new (the ignored-filter
  //    signature); the mock, which DOES filter per site, keeps scanning each site.
  //    amount_outstanding is not on real plans (it lives on invoices) -> on live
  //    data this collects nothing and we return below WITHOUT the patient scan.
  const seen = new Set<string>();
  const raw: Array<{ patientId: string; planName: string; planned: number; outstanding: number; acceptedAt: string | null }> = [];
  for (let s = 0; s < siteIds.length; s += 1) {
    const siteId = siteIds[s];
    let ignoredFilter = false;
    try {
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const res = await client.listTreatmentPlans({ siteId: dentallySiteId(siteId), page, perPage: PER_PAGE });
        const plans = res.treatment_plans ?? [];
        let newInPage = 0;
        for (const pl of plans) {
          const r = pl as Record<string, unknown>;
          const id = String(r.id ?? "");
          if (id && seen.has(id)) continue; // already counted (real Dentally repeats the group per site)
          if (id) seen.add(id);
          newInPage += 1;
          const outstanding = num(r.amount_outstanding);
          if (outstanding <= 0) continue;
          raw.push({
            patientId: String(r.patient_id ?? ""),
            planName: str(r.nickname) ?? str(r.name) ?? "Treatment plan",
            planned: num(r.private_treatment_value ?? r.planned_private_treatment_value),
            outstanding,
            acceptedAt: str(r.start_date) ?? str(r.accepted_at),
          });
        }
        // Ignored-filter signature: a NON-first site returned a page of plans of
        // which NONE are new — it is repeating an earlier site's list (real Dentally
        // ignores site_id), so the whole group is already covered. Stop scanning.
        // An EMPTY site (no plans) or an errored site is NOT this signature — a site
        // can legitimately have no plans — so those must NEVER stop the scan, or the
        // per-site-filtering mock would silently drop a later site's real plans.
        if (s > 0 && plans.length > 0 && newInPage === 0) {
          ignoredFilter = true;
          break;
        }
        if (plans.length < PER_PAGE) break;
      }
    } catch (err) {
      console.error(`[dentally] listTreatmentPlans failed for site ${siteId}; skipping this site`, err);
    }
    if (ignoredFilter) break;
  }

  // Live-data fast path: nothing outstanding -> skip the (expensive) patient scan.
  if (raw.length === 0) return [];

  // 2. Resolve patient name + real site only for the plans that survived. Plans carry
  //    no site_id, so attribute by the patient's site and DROP any plan whose patient
  //    is not in the requested Vitality sites — this is what keeps the other four
  //    practices' plans on the shared group key from leaking into this client's view.
  const patients = await listPatients(siteIds);
  const nameById = new Map(patients.map((p) => [p.id, p.name]));
  const siteByPatient = new Map(patients.map((p) => [p.id, p.siteId]));
  const allow = new Set(siteIds);
  const out: OutstandingRecord[] = [];
  for (const p of raw) {
    const site = siteByPatient.get(p.patientId);
    if (!site || !allow.has(site)) continue;
    out.push({
      patientId: p.patientId,
      patientName: nameById.get(p.patientId) ?? "Patient",
      siteId: site,
      planName: p.planName,
      planned: p.planned,
      outstanding: p.outstanding,
      acceptedAt: p.acceptedAt,
    });
  }
  return out.sort((a, b) => b.outstanding - a.outstanding);
}
