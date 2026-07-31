import { cache } from "react";
import { DentallyClient } from "./client";
import { normaliseAppointmentState } from "./appointment-state";
import { dentallySiteId, siteIdFromDentally } from "@/lib/mock/clients";
import { normaliseGender, type Gender } from "@/lib/patient/demographics";
import { readPlanId } from "@/lib/calendar/funding";
import { londonDayStartIso, londonDayEndIso } from "@/lib/calendar/availability";

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

export interface PractitionerRecord {
  /** Dentally practitioner id (what an appointment's practitioner_id expects). */
  id: string;
  name: string;
}

/**
 * A site's ACTIVE practitioners for our INTERNAL site id (read-only GET
 * /v1/practitioners), mapped to {id, name}. Mirrors the availability flow's read
 * (agent tools.ts find_slots): keep only active rows, and rows whose site_id matches
 * the requested site when Dentally scopes them. Best-effort: [] on error, so a
 * practitioner picker degrades to empty rather than breaking the page.
 */
export async function listSitePractitioners(internalSiteId: string): Promise<PractitionerRecord[]> {
  return (await listSitePractitionersSafe(internalSiteId)).practitioners;
}

/**
 * Read through a caller-supplied Dentally client instead of the environment one.
 *
 * The move path uses this so the guard reads and the write it guards go to the
 * SAME Dentally instance. write.ts takes its own DENTALLY_WRITE_BASE_URL
 * precisely so writes can be pointed at a sandbox, and a guard answered by a
 * different instance than the one being written to is not a guard at all.
 * Supplying a client also bypasses the 60 second read cache, because a
 * patient-safety write must not be approved on a minute-old picture.
 */
export interface ThroughClient {
  client?: DentallyClient;
}

export interface PractitionersRead {
  practitioners: PractitionerRecord[];
  /**
   * True when the read could not be trusted.
   *
   * The plain wrapper above returns [] on any error, which on the diary would
   * collapse the column set to only the clinicians derivable from the day's
   * appointments: a clinician with an empty list day would VANISH, and a
   * half-staffed diary would look correctly staffed and correctly free. A caller
   * that must tell an outage apart from a quiet day reads this instead of
   * guessing from an empty array. A failed read is deliberately NEVER cached.
   */
  failed: boolean;
}

const PRACTITIONERS_CACHE_KEY = (siteId: string) => `practitioners:${siteId}`;

/**
 * Like listSitePractitioners, but reporting whether the read failed, and cached
 * on success with the same 60 second TTL as the appointment reads (so paging the
 * diary day by day does not re-fetch the column set every time).
 */
export async function listSitePractitionersSafe(
  internalSiteId: string,
  opts: ThroughClient = {},
): Promise<PractitionersRead> {
  const cacheKey = PRACTITIONERS_CACHE_KEY(internalSiteId);
  // A caller that supplied its OWN client bypasses the cache in both directions.
  // Reading it would answer a question about one Dentally instance with another
  // instance's answer, and writing to it would poison every read-path caller.
  if (!process.env.VITEST && !opts.client) {
    const hit = readCache.get(cacheKey);
    if (hit && Date.now() - hit.at < READ_CACHE_TTL_MS) return hit.value as PractitionersRead;
  }

  const client = opts.client ?? dentallyFromEnv();
  const siteUuid = dentallySiteId(internalSiteId);
  let result: PractitionersRead;
  try {
    const res = await client.listPractitioners(siteUuid);
    const rows = Array.isArray(res.practitioners) ? res.practitioners : [];
    const practitioners = rows
      .map((raw) => {
        const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
        const user = (r.user && typeof r.user === "object" ? r.user : {}) as Record<string, unknown>;
        const first = str(user.first_name) ?? "";
        const last = str(user.last_name) ?? "";
        const name = `${first} ${last}`.trim() || str(user.name) || "Practitioner";
        const active = r.active === true;
        const siteMatch = typeof r.site_id !== "string" || r.site_id === siteUuid;
        return { id: String(r.id ?? ""), name, active, siteMatch };
      })
      .filter((p) => p.id !== "" && p.active && p.siteMatch)
      .map(({ id, name }) => ({ id, name }));
    result = { practitioners, failed: false };
  } catch (err) {
    console.error("[dentally] listSitePractitioners failed", err);
    result = { practitioners: [], failed: true };
  }

  if (!process.env.VITEST && !result.failed && !opts.client) {
    readCache.set(cacheKey, { at: Date.now(), value: result });
  }
  return result;
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
  /** 'male' | 'female' | null (normalised from Dentally's gender; null = not on file). */
  gender: Gender | null;
  smsConsent: boolean;
  emailConsent: boolean;
  /**
   * The patient's Dentally payment plan id, or null when there is none on file.
   *
   * Funding (NHS / Private / UDC) is a PATIENT-level fact: an appointment payload
   * carries no payment plan at all, so the diary resolves the day's distinct
   * patients and reads the plan from here. Null covers both "absent" and "plan
   * zero", and an id outside this practice's whitelist stays a raw number so the
   * caller can resolve it to "unknown" rather than to a guessed "private".
   */
  paymentPlanId: number | null;
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
  /**
   * Whatever the receptionist typed on the booking ("nervous patient, allow extra
   * time", "needs pre med, check with dentist", "interpreter booked"). The single
   * most operationally useful field on a diary block, and the reason the block
   * carries a note dot that survives truncation. The live field NAME is
   * unverified, so it is read defensively (notes, then note) and renders as
   * nothing at all when absent, never as an empty line.
   */
  note: string | null;
  practitioner: string | null;
  /**
   * The Dentally practitioner id. The diary groups appointments into one column
   * per clinician, and that grouping MUST key on this rather than on the
   * `practitioner` display name: two clinicians can share a surname, a name can
   * be recorded inconsistently, and a name is not what /v1/practitioners returns
   * as its key. Null when Dentally omits it, which the diary shows as an
   * explicit unassigned column rather than silently dropping the appointment.
   */
  practitionerId: string | null;
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
/**
 * A Dentally record id as a string, or null when it is absent.
 *
 * Ids arrive as NUMBERS from real Dentally and as strings from the mock, so any
 * id used as a join key has to normalise both. A finite number becomes its
 * decimal string; anything else falls back to the string rule.
 */
function idOf(v: unknown): string | null {
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  return str(v);
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
    gender: normaliseGender(r.gender),
    smsConsent: bool(r.use_sms),
    emailConsent: bool(r.use_email),
    paymentPlanId: readPlanId(r),
  };
}

// Dentally caps a list page at ~100 rows. A single unpaged call therefore silently
// truncates every list endpoint at the first 100 rows on a real-size practice — the
// reviews module 404s on almost every patient/appointment, and the co-pilot's diary
// omits most of the day, all while passing dry-run (the mock returns every fixture in
// one page). Loop pages until a short (< PER_PAGE) one, bounded by MAX_PAGES.
const PER_PAGE = 100;
const MAX_PAGES = 100; // hard bound: up to 10k rows/site/endpoint, so a bad upstream can't loop forever
// The outstanding scan pages the INVOICES index (real Dentally holds the balance on
// invoices, not on treatment_plans, which carry no amount_outstanding). Real Dentally
// may ignore site_id here and return the whole group per site, so the scan dedupes by
// invoice id and stops early once a later site adds nothing new. Bounded so a large
// practice's invoice history cannot loop unbounded on the page path.
// With the server-side `paid=false` filter the unpaid set is small, so the scan
// terminates on a short page well before this cap; the cap only bounds the fallback
// case where a source ignores the filter and returns the whole (mostly-paid) index.
const OUTSTANDING_MAX_PAGES = 40;

async function pageAll<T>(fetchPage: (page: number) => Promise<T[]>, maxPages: number = MAX_PAGES): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const rows = await fetchPage(page);
    out.push(...rows);
    if (rows.length < PER_PAGE) break; // short page => last page
  }
  return out;
}

// Cross-request TTL cache for the expensive live Dentally DISPLAY reads. Every
// force-dynamic page re-pages Dentally on navigation; on a real-size practice
// (thousands of patients + the whole group's treatment plans) that makes the app
// feel slow, and the reads compete with the hourly backfill for the rate budget.
// Fluid Compute keeps instances warm, so a short per-instance TTL turns repeat and
// SHARED reads (Home, Payments and the brief all want the same outstanding +
// appointments) into instant hits. DISPLAY only: the sync/backfill uses the raw
// DentallyClient directly, so its data always stays fresh. Stale by at most the TTL.
const READ_CACHE_TTL_MS = 60_000;
const readCache = new Map<string, { at: number; value: unknown }>();

async function cachedRead<T>(key: string, fn: () => Promise<T>, ttlMs = READ_CACHE_TTL_MS): Promise<T> {
  // Unit tests exercise the real read directly (no cross-test cache pollution).
  if (process.env.VITEST) return fn();
  const now = Date.now();
  const hit = readCache.get(key);
  if (hit && now - hit.at < ttlMs) return hit.value as T;
  const value = await fn();
  readCache.set(key, { at: now, value });
  if (readCache.size > 300) {
    // Bound memory: drop the oldest quarter of entries.
    for (const [k] of [...readCache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 75)) {
      readCache.delete(k);
    }
  }
  return value;
}

/** All patients across the given sites. The 3 sites are paged CONCURRENTLY (peak
 *  concurrency = site count), so wall-clock is the slowest single site, not the sum.
 *  /v1/patients DOES honour site_id server-side, so this stays a per-site scan.
 *  `opts.maxPages` bounds the per-site page scan (e.g. the Patients page shows a fast
 *  first ~300); callers that omit it keep the full scan (name resolution, sync, etc.). */
export function listPatients(siteIds: string[], opts?: { maxPages?: number }): Promise<PatientRecord[]> {
  const key = `patients:${[...siteIds].sort().join("|")}:${opts?.maxPages ?? "all"}`;
  return cachedRead(key, () => _listPatientsUncached(siteIds, opts?.maxPages));
}
async function _listPatientsUncached(siteIds: string[], maxPages?: number): Promise<PatientRecord[]> {
  const client = dentallyFromEnv();
  const perSite = await Promise.all(
    siteIds.map(async (siteId) => {
      try {
        const rows = await pageAll(
          (page) =>
            client.listPatients({ siteId: dentallySiteId(siteId), page, perPage: PER_PAGE }).then((res) => res.patients ?? []),
          maxPages,
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

// A server-side search fans a `query=` string out to Dentally per site (name/contact),
// so we never page the whole ~8k patient book to find one person. Bounded to 3 pages
// per site (300 matches/site is far beyond any usable result set) and cached briefly,
// keyed on the query, so a debounced keystroke stream doesn't hammer Dentally.
const SEARCH_MAX_PAGES = 3;

/** Server-side patient search across the given sites via Dentally's `query=` param
 *  (name/contact). Returns [] for a trimmed query shorter than 2 chars. Sites are
 *  searched CONCURRENTLY with the same per-site resilience as listPatients (a site
 *  that errors yields [] and is logged), results flattened and sorted by name. */
export function searchPatients(siteIds: string[], query: string): Promise<PatientRecord[]> {
  const q = query.trim();
  if (q.length < 2) return Promise.resolve([]);
  const key = `patsearch:${[...siteIds].sort().join("|")}:${q}`;
  return cachedRead(key, () => _searchPatientsUncached(siteIds, q), 30_000);
}
async function _searchPatientsUncached(siteIds: string[], query: string): Promise<PatientRecord[]> {
  const client = dentallyFromEnv();
  const perSite = await Promise.all(
    siteIds.map(async (siteId) => {
      try {
        const rows = await pageAll(
          (page) =>
            client
              .listPatients({ siteId: dentallySiteId(siteId), query, page, perPage: PER_PAGE })
              .then((res) => res.patients ?? []),
          SEARCH_MAX_PAGES,
        );
        return rows.map((p) => toPatient(p as Record<string, unknown>));
      } catch (err) {
        console.error(`[dentally] searchPatients failed for site ${siteId}; skipping this site`, err);
        return [] as PatientRecord[];
      }
    }),
  );
  return perSite.flat().sort((a, b) => a.name.localeCompare(b.name));
}

/** Exact patient count across the given sites, straight from Dentally's index
 *  metadata (`meta.total` — one 1-row call per site, no book scan). Cached for
 *  5 minutes: it is a headline number, not an operational feed. Returns null when
 *  NO site exposed a total (the local mock has no meta), so callers can fall back
 *  to counting whatever slice they fetched. */
export function countPatients(siteIds: string[]): Promise<number | null> {
  const key = `patcount:${[...siteIds].sort().join("|")}`;
  return cachedRead(key, () => _countPatientsUncached(siteIds), 300_000);
}
async function _countPatientsUncached(siteIds: string[]): Promise<number | null> {
  const client = dentallyFromEnv();
  const totals = await Promise.all(
    siteIds.map(async (siteId) => {
      try {
        return await client.countPatients(dentallySiteId(siteId));
      } catch (err) {
        console.error(`[dentally] countPatients failed for site ${siteId}`, err);
        return null;
      }
    }),
  );
  if (totals.every((t) => t === null)) return null;
  return totals.reduce<number>((sum, t) => sum + (t ?? 0), 0);
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
    // Mapped through siteIdFromDentally, exactly as toPatient does. Real Dentally
    // sends a site UUID while every consumer filters on our internal id
    // ("site-cc"), so an unmapped value would make the diary drop every row and
    // show a confident "Nothing booked" on every day. When Dentally gives an id
    // we do not know, the row is attributed to the site it was QUERIED from,
    // which is what the dashboard read already does. It can never return a raw UUID.
    siteId: siteIdFromDentally(str(r.site_id) ?? "") ?? fallbackSiteId,
    start: str(r.start_time) ?? "",
    finish: str(r.finish_time),
    durationMin: num(r.duration) || 30,
    // Canonicalised: real Dentally sends "Did not attend" / "In surgery" etc.;
    // downstream sets (diary gaps, brief gap count) compare did_not_attend-style.
    state: normaliseAppointmentState(r.state),
    reason: str(r.reason),
    // The live field name is unverified, so both spellings are tried before
    // giving up. Absent stays null and the diary simply draws nothing.
    note: str(r.notes) ?? str(r.note),
    practitioner: str(r.practitioner),
    // NUMERIC on live Dentally, a string only in the mock (see
    // lib/booking/slots.ts and write.ts, which both already branch on it).
    // str() alone returns null for a number, which would send EVERY live
    // appointment into the diary's "Unassigned" column and leave every
    // clinician's column reading "Nothing booked" for a fully booked day. The
    // practitioner LIST id is built with String(), so both sides of the join
    // must normalise the same way.
    practitionerId: idOf(r.practitioner_id),
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
  const from = range?.from ?? "";
  const to = range?.to ?? "";
  const rows = await cachedRead(
    `appts:${siteIds.join("|")}:${from}:${to}`,
    () => listAppointmentsCached(siteIds.join("|"), from, to),
  );
  return [...rows].sort((a, b) => (a.start < b.start ? -1 : 1));
}

export interface AppointmentsRead {
  appointments: AppointmentRecord[];
  /**
   * True only when the read could not be trusted: every requested site failed
   * outright, or a site failed and the combined result came back empty. A
   * calendar rendering zero rows is otherwise indistinguishable from "the day
   * is genuinely free", so a caller that must tell those apart (the calendar
   * page, go-live defect B3) reads this instead of guessing from an empty
   * array. Deliberately NEVER cached: caching a failed read would serve the
   * empty-diary lie back to every reader for the rest of the TTL.
   */
  failed: boolean;
  /**
   * The sites whose own read threw, whether or not any other site returned rows.
   *
   * `failed` is a whole-request verdict and is deliberately conservative, so it
   * stays false when one site failed and another site's real data came back. A
   * caller that shows ONE site at a time out of a multi-site read (the diary's
   * site switcher) cannot use that verdict: switching to the failed site would
   * draw a confident empty day. It reads this list instead.
   */
  failedSiteIds: string[];
}

/**
 * Like listAppointments, but for a caller that must tell a genuine Dentally
 * read failure apart from a day that is genuinely free (B3), and must never
 * let a failed read be cached and served back as "no appointments". A
 * successful read IS still cached (same TTL as listAppointments), so repeat
 * navigation within an already-loaded window stays fast.
 */
export async function listAppointmentsSafe(
  siteIds: string[],
  range?: { from?: string; to?: string },
): Promise<AppointmentsRead> {
  const from = range?.from ?? "";
  const to = range?.to ?? "";
  const cacheKey = `apptssafe:${[...siteIds].sort().join("|")}:${from}:${to}`;

  if (!process.env.VITEST) {
    const hit = readCache.get(cacheKey);
    if (hit && Date.now() - hit.at < READ_CACHE_TTL_MS) return hit.value as AppointmentsRead;
  }

  const client = dentallyFromEnv();
  const failedSiteIds: string[] = [];
  const perSite = await Promise.all(
    siteIds.map(async (siteId) => {
      try {
        const rows = await pageAll((page) =>
          client
            .listAppointments({
              siteId: dentallySiteId(siteId),
              fromDate: from || undefined,
              toDate: to || undefined,
              page,
              perPage: PER_PAGE,
            })
            .then((res) => res.appointments ?? []),
        );
        return rows.map((a) => toAppointment(a as Record<string, unknown>, siteId));
      } catch (err) {
        console.error(`[dentally] listAppointments (safe) failed for site ${siteId}; skipping this site`, err);
        failedSiteIds.push(siteId);
        return [] as AppointmentRecord[];
      }
    }),
  );
  const appointments = perSite.flat().sort((a, b) => (a.start < b.start ? -1 : 1));
  // A failure only needs surfacing when it could plausibly explain the empty
  // result: if another site's real data still came back, the diary is showing
  // what it genuinely has, not lying about a day being free. Every-site-failed
  // always lands here too (0 rows can ever be collected in that case). A caller
  // that slices this result down to ONE site reads failedSiteIds, not this.
  const failed = siteIds.length > 0 && failedSiteIds.length > 0 && appointments.length === 0;

  const result: AppointmentsRead = { appointments, failed, failedSiteIds };
  // A PARTIAL read is not cached either. Caching it would serve one practice's
  // missing day back to every reader for the rest of the TTL, which is the same
  // empty-diary lie as the all-sites-failed case, just narrower.
  if (!process.env.VITEST && failedSiteIds.length === 0) {
    readCache.set(cacheKey, { at: Date.now(), value: result });
  }
  return result;
}

/**
 * Drop every cached appointment window whose site set intersects `siteIds`.
 *
 * WHY THIS HAS TO EXIST. listAppointmentsSafe caches a successful window for 60s
 * under `apptssafe:<sites>:<from>:<to>` and had no invalidation hook, so a
 * router.refresh() straight after a CONFIRMED appointment move repainted the OLD
 * time for up to a minute. To the person who just moved it that reads as a silent
 * revert: the very failure the read-back confirmation exists to prevent, produced
 * by the cache that makes the page fast. The move route calls this after a
 * confirmed write, and only then may the board refresh.
 *
 * Deliberately keyed on INTERSECTION, not equality: the diary reads one site at a
 * time, but Home and the daily brief read all three in one key, and that combined
 * entry holds the same stale row.
 */
export function invalidateAppointmentsCache(siteIds: string[]): void {
  if (siteIds.length === 0) return;
  const wanted = new Set(siteIds);
  const prefix = "apptssafe:";
  for (const key of [...readCache.keys()]) {
    if (!key.startsWith(prefix)) continue;
    // `apptssafe:<a|b|c>:<from>:<to>`: site ids carry no colon, so the first
    // segment after the prefix is the whole site set.
    const sitePart = key.slice(prefix.length).split(":")[0] ?? "";
    if (sitePart.split("|").some((s) => wanted.has(s))) readCache.delete(key);
  }
}

/**
 * The raw availability rows for one site's practitioners across a day range.
 *
 * This is the diary's "who is actually working" read, and it is the honest source:
 * our own opening-hours config has never been checked against the practice and is
 * already contradicted by live windows running past its configured close.
 *
 * Three decisions worth stating:
 *  - NO `duration` is sent. The diary wants the raw WINDOW so it can shade a
 *    session; chunking it into bookable slots at the parse seam (which the booking
 *    path does) throws away exactly the shape the grid needs.
 *  - An EMPTY practitioner list issues NO call at all and is not a failure. It is
 *    the correct answer for a site whose practitioner read returned nobody.
 *  - A FAILED read is NEVER cached. Caching it would serve "nobody is working" back
 *    to every reader for the rest of the TTL, and on a busy Monday that is a
 *    receptionist ringing patients to cancel a day that is in fact fully staffed.
 *
 * Returns raw rows: parsing, day-splitting and the untagged-row policy belong to
 * parseAvailabilityWindows, which is pure and tested.
 */
/** Availability rows per page, and the ceiling on how many pages are walked. */
const AVAILABILITY_PER_PAGE = 100;
const AVAILABILITY_MAX_PAGES = 20;

export async function listDiaryAvailabilitySafe(
  args: {
    siteId: string;
    practitionerIds: readonly string[];
    fromDayKey: string;
    toDayKey: string;
  },
  opts: ThroughClient = {},
): Promise<{ rows: unknown[]; failed: boolean }> {
  const ids = [...args.practitionerIds].filter((id) => id !== "");
  if (ids.length === 0) return { rows: [], failed: false };

  const cacheKey = `diaryavail:${args.siteId}:${[...ids].sort().join("|")}:${args.fromDayKey}:${args.toDayKey}`;
  if (!process.env.VITEST && !opts.client) {
    const hit = readCache.get(cacheKey);
    if (hit && Date.now() - hit.at < READ_CACHE_TTL_MS) return hit.value as { rows: unknown[]; failed: boolean };
  }

  const client = opts.client ?? dentallyFromEnv();
  let result: { rows: unknown[]; failed: boolean };
  try {
    // PAGED, like every other list read here, and safe whether or not this
    // endpoint actually pages. Rows are keyed and de-duplicated, so an endpoint
    // that IGNORES page simply returns the same set on page two, contributes
    // nothing new and ends the walk. A short page ends it too. Only a walk that
    // keeps producing new rows until the ceiling is a FAILED read, because the
    // alternative is presenting a truncated week as "these clinicians are not
    // working": a positive claim that the practice is shut, from a partial read.
    const rows: unknown[] = [];
    const seen = new Set<string>();
    let complete = false;
    for (let page = 1; page <= AVAILABILITY_MAX_PAGES; page += 1) {
      const res = await client.getAvailability({
        practitionerIds: ids,
        startTime: londonDayStartIso(args.fromDayKey),
        finishTime: londonDayEndIso(args.toDayKey),
        page,
        perPage: AVAILABILITY_PER_PAGE,
      });
      const batch = Array.isArray(res.availability) ? res.availability : [];
      let added = 0;
      for (const raw of batch) {
        const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
        const key = `${String(r.practitioner_id ?? "")}|${String(r.start_time ?? "")}|${String(r.finish_time ?? "")}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(raw);
        added += 1;
      }
      if (batch.length < AVAILABILITY_PER_PAGE || added === 0) {
        complete = true;
        break;
      }
    }
    if (!complete) {
      console.error(
        `[dentally] getAvailability for site ${args.siteId} did not run out of pages within ${AVAILABILITY_MAX_PAGES}; treating the read as failed`,
      );
      result = { rows: [], failed: true };
    } else {
      result = { rows, failed: false };
    }
  } catch (err) {
    console.error(`[dentally] getAvailability failed for site ${args.siteId}`, err);
    result = { rows: [], failed: true };
  }

  if (!process.env.VITEST && !result.failed && !opts.client) {
    readCache.set(cacheKey, { at: Date.now(), value: result });
  }
  return result;
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
  /** Balance still owed across this patient's unpaid invoices (0 if all settled). */
  outstanding: number;
}

/** Full record for one patient: appointment history, treatment plans, notes, lifetime spend.
 *  Cached (short TTL) so re-opening the same record is instant. */
export function getPatientDetail(patientId: string, siteId: string): Promise<PatientDetail> {
  return cachedRead(`patientdetail:${siteId}:${patientId}`, () => _getPatientDetailUncached(patientId, siteId), 30_000);
}
async function _getPatientDetailUncached(patientId: string, siteId: string): Promise<PatientDetail> {
  const client = dentallyFromEnv();

  const apptsP = client
    .getPatientAppointments(patientId)
    .then((res) => (res.appointments ?? []).map((a) => toAppointment(a as Record<string, unknown>, siteId)))
    .catch(() => [] as AppointmentRecord[]);

  // Query THIS patient's plans directly (patient_id) instead of paging the whole
  // group's treatment_plans (up to 100 calls) to filter one patient out — that was
  // ~100 Dentally calls on every record open. A patient has few plans, so a small
  // bound is plenty; the client-side filter stays as a safety net in case Dentally
  // ignores patient_id the way it ignores site_id.
  const plansP = pageAll(
    (page) =>
      client
        .listTreatmentPlans({ siteId: dentallySiteId(siteId), patientId, page, perPage: PER_PAGE })
        .then((res) => res.treatment_plans ?? []),
    5,
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

  const invoicesP = client
    .getPatientInvoices(patientId)
    .then((res) => (res.invoices ?? []).map((inv) => inv as Record<string, unknown>))
    .catch(() => [] as Record<string, unknown>[]);

  const [appointments, plans, notes, invoices] = await Promise.all([apptsP, plansP, notesP, invoicesP]);
  const lifetimeSpend = invoices.reduce((sum, r) => sum + invoicePaid(r), 0);
  const outstanding = invoices.reduce((sum, r) => sum + invoiceOutstanding(r), 0);
  appointments.sort((a, b) => (a.start < b.start ? 1 : -1)); // newest first
  return { appointments, plans, notes, lifetimeSpend, outstanding };
}

/** Outstanding balances across the given sites, one aggregated row per patient, from
 *  unpaid invoices (real Dentally holds the balance on invoices, not on plans). */
export function listOutstanding(siteIds: string[]): Promise<OutstandingRecord[]> {
  return cachedRead(`outstanding:${[...siteIds].sort().join("|")}`, () => _listOutstandingUncached(siteIds));
}

// Invoice statuses that are NOT a live debt (never counted as outstanding or paid).
// Real Dentally uses `status` (e.g. "new"); the exact non-debt vocabulary is confirmed
// against the sandbox — this set is deliberately permissive so an unknown status still
// counts as owed rather than being silently dropped.
const NON_DEBT_INVOICE_STATUSES = new Set(["cancelled", "written_off", "void", "credited", "draft"]);

/**
 * The balance still owed on one invoice, or 0 when settled / not a live debt.
 *
 * CALIBRATED to the documented real Dentally invoice shape: `amount` (gross),
 * `amount_outstanding` (the balance, already net of partial payments), `paid` (a
 * BOOLEAN), `status`. Falls back to the mock/legacy numeric shape (`total` - numeric
 * `paid`) so both work. The earlier version read `outstanding`/`total`/`gross` and a
 * numeric `paid`, none of which exist on live Dentally, so it returned 0 for every
 * real invoice. Confirm exact field units (pounds vs pence) against the sandbox.
 */
function invoiceOutstanding(r: Record<string, unknown>): number {
  const status = str(r.status) ?? str(r.state);
  if (status && NON_DEBT_INVOICE_STATUSES.has(status)) return 0;
  // Dentally's own balance field already reflects partial payments — trust it first.
  if (r.amount_outstanding != null) return Math.max(0, num(r.amount_outstanding));
  if (r.outstanding != null) return Math.max(0, num(r.outstanding));
  const gross = num(r.total ?? r.amount ?? r.gross ?? r.value);
  // Live `paid` is a boolean (fully paid?); mock `paid` is the numeric amount paid.
  if (typeof r.paid === "boolean") return r.paid ? 0 : Math.max(0, gross);
  return Math.max(0, gross - num(r.paid));
}

/** The amount already PAID on one invoice. Live Dentally: gross minus the outstanding
 *  balance (or the full gross when the boolean `paid` is true); mock: the numeric `paid`.
 *  Used for lifetime spend, which otherwise summed booleans (1/0) as pounds on live. */
function invoicePaid(r: Record<string, unknown>): number {
  if (typeof r.paid === "number") return num(r.paid); // mock/legacy shape
  const gross = num(r.amount ?? r.total);
  if (r.amount_outstanding != null) return Math.max(0, gross - num(r.amount_outstanding));
  return r.paid === true ? gross : 0;
}

async function _listOutstandingUncached(siteIds: string[]): Promise<OutstandingRecord[]> {
  const client = dentallyFromEnv();

  // 1. Scan the invoices index ONCE. Real Dentally may IGNORE the site_id filter and
  //    return the entire (5-practice) group's invoices on every site call, so dedupe
  //    by invoice id and stop as soon as a later site's first page adds nothing new
  //    (the ignored-filter signature). A finalised invoice with total > paid is a live
  //    balance owed. Aggregate per patient (a patient can carry several unpaid ones).
  //    If the index rejects a site-scoped/unscoped list, the per-site catch fails safe
  //    to [] rather than crashing Payments/Home/the brief.
  const seen = new Set<string>();
  const byPatient = new Map<string, { outstanding: number; invoiced: number; latest: string | null; count: number }>();
  for (let s = 0; s < siteIds.length; s += 1) {
    const siteId = siteIds[s];
    let ignoredFilter = false;
    // Truncation guard: assume truncated until we terminate cleanly on a short page or
    // the ignored-filter signature. If a site exhausts the page cap on full pages the
    // total may be understated, so we log it rather than presenting a silent partial.
    let sawShortPage = false;
    try {
      for (let page = 1; page <= OUTSTANDING_MAX_PAGES; page += 1) {
        const res = await client.listInvoices({ siteId: dentallySiteId(siteId), page, perPage: PER_PAGE, paid: false });
        const invoices = res.invoices ?? [];
        let newInPage = 0;
        for (const inv of invoices) {
          const r = inv as Record<string, unknown>;
          const id = String(r.id ?? "");
          if (id && seen.has(id)) continue; // already counted (Dentally repeats the group per site)
          if (id) seen.add(id);
          newInPage += 1;
          const outstanding = invoiceOutstanding(r);
          if (outstanding <= 0) continue;
          const patientId = String(r.patient_id ?? "");
          if (!patientId) continue;
          const agg = byPatient.get(patientId) ?? { outstanding: 0, invoiced: 0, latest: null, count: 0 };
          agg.outstanding += outstanding;
          agg.invoiced += num(r.amount ?? r.total ?? r.gross ?? r.value);
          agg.count += 1;
          const at = str(r.created_at) ?? str(r.date) ?? str(r.issued_at);
          if (at && (!agg.latest || at > agg.latest)) agg.latest = at;
          byPatient.set(patientId, agg);
        }
        // Ignored-filter signature: a NON-first site returned a page of invoices of
        // which NONE are new — it is repeating an earlier site's list (real Dentally
        // ignores site_id), so the whole group is already covered. An EMPTY site (no
        // invoices) or an errored site is NOT this signature and must never stop the
        // scan, or a per-site-filtering source would silently drop a later site.
        if (s > 0 && invoices.length > 0 && newInPage === 0) {
          ignoredFilter = true;
          sawShortPage = true; // covered the whole group; not a truncation
          break;
        }
        if (invoices.length < PER_PAGE) { sawShortPage = true; break; }
      }
      if (!sawShortPage) {
        console.warn(
          `[dentally] listOutstanding: site ${siteId} hit the ${OUTSTANDING_MAX_PAGES}-page cap without a short page; ` +
            `the outstanding total may be understated (raise OUTSTANDING_MAX_PAGES or confirm the paid=false filter is honoured).`,
        );
      }
    } catch (err) {
      console.error(`[dentally] listInvoices failed for site ${siteId}; skipping this site`, err);
    }
    if (ignoredFilter) break;
  }

  // Live-data fast path: nothing outstanding -> skip the (expensive) patient scan.
  if (byPatient.size === 0) return [];

  // 2. Resolve patient name + real site only for the patients that carry a balance.
  //    Invoices are attributed by the patient's site and DROP any whose patient is not
  //    in the requested Vitality sites — this keeps the other four practices' balances
  //    on the shared group index from leaking into this client's view.
  //    The bounded full-book scan caps at ~10k rows/site, so a debtor sorting past that
  //    bound would be MISSING from it and their balance silently dropped. Resolve any
  //    such miss by a direct id read so no live debt is omitted from the total.
  const patients = await listPatients(siteIds);
  const byId = new Map(patients.map((p) => [p.id, p]));
  const allow = new Set(siteIds);
  const out: OutstandingRecord[] = [];
  for (const [patientId, agg] of byPatient) {
    let patient = byId.get(patientId);
    if (!patient) {
      const resolved = await getPatientById(patientId);
      if (resolved) patient = resolved;
    }
    // Attribute by the patient's real site; drop any whose patient is not in the
    // requested Vitality sites, or that we could not resolve at all (better a small
    // omission than a mis-attributed balance).
    if (!patient || !allow.has(patient.siteId)) continue;
    out.push({
      patientId,
      patientName: patient.name,
      siteId: patient.siteId,
      planName: agg.count === 1 ? "Outstanding invoice" : `${agg.count} outstanding invoices`,
      planned: agg.invoiced,
      outstanding: agg.outstanding,
      acceptedAt: agg.latest,
    });
  }
  return out.sort((a, b) => b.outstanding - a.outstanding);
}
