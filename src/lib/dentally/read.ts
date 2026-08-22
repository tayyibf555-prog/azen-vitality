import { cache } from "react";
import { after } from "next/server";
import { DentallyBudgetExceededError, DentallyClient, rethrowIfBudgetRefused } from "./client";
import { normaliseAppointmentState } from "./appointment-state";
import { dentallyScopeRefusal, dentallyScopeRefused, runWithDentallyPriority } from "./budget";
import { notesFromEnvelope, toNoteRecords, type NoteRecord } from "./notes-shape";
import { metaTotal, pageToCeiling } from "./paging";
import { dentallySiteId, siteIdFromDentally, clientIdForSites } from "@/lib/mock/clients";
import {
  createDisplayCache,
  supabaseDisplayCacheStore,
  type DisplayCache,
} from "./display-cache";
import { normaliseGender, type Gender } from "@/lib/patient/demographics";
import { readPlanId } from "@/lib/calendar/funding";
import {
  availabilityRowsWithinDays,
  dayKeysBetween,
  diaryAvailabilityRequest,
} from "@/lib/calendar/availability";

/**
 * The Dentally API key for READ / sync operations (listing patients, appointments,
 * plans, invoices; resolving a message recipient). Prefers the dedicated read-only
 * key when set, falling back to DENTALLY_API_KEY so nothing breaks before it is
 * configured.
 *
 * WRITE paths (the agent booking appointments or creating patients, in
 * src/lib/agent/tools.ts via the inbound/voice routes' own client) deliberately do
 * NOT use this: they go through dentallyAgentClient() and read DENTALLY_WRITE_*.
 *
 * THAT SEPARATION IS NOW ENFORCED, NOT MERELY INTENDED. This comment used to end
 * "so a read-only key can never be used to attempt a write against real Dentally",
 * and that was false twice over. The key named DENTALLY_PROD_READONLY_API_KEY is
 * NOT read-only - its x-oauth-scopes header carries Dentally's bare umbrella forms
 * (patient, appointment, financials, treatments), each of which their own docs
 * define as including create, update and delete, over ~51,000 live patient records.
 * And nothing in the code stopped a caller handing that key to a write method;
 * the only thing that ever did was a User-Agent check on Dentally's side, which
 * this client satisfies on every request.
 *
 * So dentallyFromEnv() now builds the client with `readOnly: true`, and
 * DentallyClient.assertWritable() throws before any non-GET is even constructed.
 * Rotating the key to genuine :read scopes remains owed and is the real fix.
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
    // Every caller of this function reads. Verified: all five write methods are
    // reached only via dentallyAgentClient(). The latch makes that a property of
    // the code rather than a convention someone can breach by accident.
    readOnly: true,
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
  const clientId = clientIdForSites([internalSiteId]);
  // A caller that supplied its OWN client bypasses the cache in both directions.
  // Reading it would answer a question about one Dentally instance with another
  // instance's answer, and writing to it would poison every read-path caller.
  const useCache = displayCache && !opts.client;
  if (useCache) {
    const hit = await displayCache!.getCached<PractitionersRead>(clientId, cacheKey);
    if (hit) return hit;
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

  if (useCache && !result.failed) {
    await displayCache!.setCached(clientId, cacheKey, result, READ_CACHE_TTL_MS);
  }
  return result;
}

export interface PatientRecord {
  id: string;
  name: string;
  /**
   * Dentally's own title ("Mr", "Mrs", "Dr"), or null when the record carries none.
   *
   * It arrives on the SAME `GET /v1/patients/:id` payload every other field here
   * comes from; toPatient simply never picked it. The patient record's header
   * prints "Mr Alex Berry" exactly as Dentally does, and an absent title renders
   * the name alone rather than a guessed one.
   */
  title: string | null;
  email: string | null;
  phone: string | null;
  siteId: string;
  active: boolean;
  archivedReason: string | null;
  /**
   * The soonest of the two recall dates below, unchanged from the day this field
   * was added. Every existing caller (the patients list, the recall segment, the
   * reactivation scoring) reads this and must keep reading exactly the same value,
   * so the two split fields are ADDED alongside it rather than replacing it.
   */
  recallDueAt: string | null;
  /** Dentally's `dentist_recall_date`. Shown as its own line on the Recalls tab,
   *  because Dentally shows the two separately and staff act on them separately. */
  dentistRecallAt: string | null;
  /** Dentally's `hygienist_recall_date`. See dentistRecallAt. */
  hygienistRecallAt: string | null;
  lastVisitAt: string | null;
  dateOfBirth: string | null;
  /** 'male' | 'female' | null (normalised from Dentally's gender; null = not on file). */
  gender: Gender | null;
  smsConsent: boolean;
  emailConsent: boolean;
  /**
   * Dentally's own `medical_alert` boolean. The ONLY populated medical signal on
   * the patient object (verified: /v1/medical_histories exists but is permanently
   * empty for this practice), so this is the one Dentally medical fact we mirror —
   * and it is DIFFERENT from the medical-history questionnaire this platform may
   * author (src/lib/patient-medical). It rides the SAME `GET /v1/patients/:id`
   * payload every other field here comes from; toPatient simply never picked it.
   * Absent reads as false, which is how the record renders no alert rather than a
   * guessed one.
   */
  medicalAlert: boolean;
  /** The free text behind `medical_alert`, e.g. "Penicillin anaphylaxis", or null.
   *  Shown only when medicalAlert is true; never used to imply an alert on its own. */
  medicalAlertText: string | null;
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
  const dentistRecallAt = str(r.dentist_recall_date);
  const hygienistRecallAt = str(r.hygienist_recall_date);
  return {
    id: String(r.id ?? ""),
    name: `${first} ${last}`.trim() || "Unknown",
    title: str(r.title),
    email: str(r.email_address),
    phone: str(r.mobile_phone),
    siteId: mapSite(r.site_id),
    active: r.active !== false,
    archivedReason: str(r.archived_reason),
    // UNCHANGED expression, deliberately: dentist first, hygienist as the fallback.
    // Every existing caller depends on this exact value; the two split fields below
    // are additive.
    recallDueAt: dentistRecallAt ?? hygienistRecallAt,
    dentistRecallAt,
    hygienistRecallAt,
    lastVisitAt: str(r.last_visit_at),
    dateOfBirth: str(r.date_of_birth),
    gender: normaliseGender(r.gender),
    smsConsent: bool(r.use_sms),
    emailConsent: bool(r.use_email),
    // Free add: the same payload already carries these. medical_alert is the one
    // populated medical field on the Dentally patient object; medical_alert_text is
    // its detail. Absent stays false/null so a record with no alert renders none.
    medicalAlert: bool(r.medical_alert),
    medicalAlertText: str(r.medical_alert_text),
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

/**
 * How long an outstanding-balances blob stays fresh in the shared cache.
 *
 * Deliberately NOT the 60s default. This read is the second most expensive
 * thing the platform asks of Dentally (the invoice index plus a direct read
 * for every debtor the book scan did not reach), and the pre-warm stamps its
 * rows for fifteen minutes. With a 60s stamp here, a reader's own refresh
 * re-stamped the row back down to a minute, so the row spent most of the hour
 * expiring and re-paging the whole invoice book - the exact treadmill the
 * cross-instance cache exists to stop. One constant, so the warmer and the
 * reader cannot disagree about how long the answer is good for.
 */
export const OUTSTANDING_TTL_MS = 15 * 60_000;

// The debtors the bounded book scan does not cover are resolved by a direct id
// read (getPatientById). That fan-out runs in bounded-concurrency chunks of this
// size, so the round-trip depth of the fallback is misses/chunk rather than one
// blocking round trip per miss. Kept small so a large debtor set cannot open
// hundreds of simultaneous Dentally connections against the shared rate budget.
const DEBTOR_RESOLVE_CHUNK = 8;

// THE DISPLAY READS BELOW PAGE ON THE SHARED BOUNDED PAGER (./paging).
//
// THIS FILE USED TO DECLARE ITS OWN, `pageBounded`, and charting-read.ts declared
// `pageToCeiling` beside it: the same walk, line for line, differing only in whether
// the truncation came back or was discarded. Both also measured a short page against
// their own module's PER_PAGE while each caller chose `per_page` inside its closure,
// so nothing tied the size ASKED FOR to the size MEASURED AGAINST — the exact drift
// `pageAll` had just been fixed for in src/lib/reports/scan.ts. The shared pager takes
// `perPage` as an argument and hands it to the fetcher, so the two cannot disagree.
//
// THE TRUNCATION IS STILL DISCARDED HERE, AND THAT IS DELIBERATE — but it is now
// discarded AT THE CALL SITE (`.rows`, or `(await ...).rows`) rather than inside a
// pager that never offered it. These are DISPLAY reads: a name map, a patient list,
// an appointment feed. `listPatients` bounds at MAX_PAGES (100 pages, 10,000 rows a
// site) against a live book of ~17,000 on the largest site, and that bound is the
// point — the Patients page is not going to fetch a whole book to render a list, and
// it is not totalling money over what it gets.
//
// NEVER USE IT FOR A FIGURE. Anything that will be summed, counted or printed as a
// total belongs on reports/scan.ts's `pageAll`, where "did the walk finish?" is
// measured against Dentally's own row count and answered.

// Cross-request TTL cache for the expensive live Dentally DISPLAY reads. Every
// force-dynamic page re-pages Dentally on navigation; on a real-size practice
// (thousands of patients + the whole group's treatment plans) that makes the app
// feel slow, and the reads compete with the hourly backfill for the rate budget.
//
// TWO LAYERS (see lib/dentally/display-cache.ts):
//  - L1 is an in-process Map, so REPEAT reads on ONE warm instance are instant.
//  - L2 is the shared dentally_display_cache table (migration 0084), so a COLD
//    instance -- and there are many under Fluid Compute -- serves the read from
//    another instance's computed result and calls Dentally ZERO times until it
//    expires. That is what stops a tab walk across cold instances from burning the
//    3,600/hour Dentally budget.
//
// DISPLAY only: the sync/backfill, online-booking availability and the write-back
// that confirms a write all use the raw DentallyClient (or pass opts.client) and so
// never touch either layer -- they always reflect this exact second. Stale by at
// most the TTL. Every entry is keyed by (clientId + params), so no practice can ever
// be served another's blob.
export const READ_CACHE_TTL_MS = 60_000;

/**
 * Run a stale-while-revalidate refresh so it SURVIVES the serverless response.
 *
 * The SWR refresh must run AFTER the current response has already returned its stale
 * value. A bare floating promise is not enough on Fluid Compute: once the response is
 * flushed the platform can freeze or reclaim the instance before a detached promise
 * settles, so the refresh would silently never run and the row would stay stale
 * forever. next/after registers the task with the invocation's waitUntil, which keeps
 * the instance alive until it settles. It can only be called inside a request/render
 * scope; the try/catch falls back to a detached run for any caller outside one (the
 * pre-warm cron never hits this path — it computes on a true miss, synchronously).
 */
function afterScheduler(task: () => Promise<void>): void {
  // A STALE-WHILE-REVALIDATE REFRESH IS BACKGROUND WORK, BY DEFINITION: the reader
  // has already been handed the stale value and is not waiting on this. Classifying
  // it as background (src/lib/dentally/budget.ts) means it is refused FIRST, at 60%
  // of the hour's Dentally budget, instead of competing with the very reads it
  // exists to make fast.
  //
  // That is not a nicety. `refreshing` in display-cache.ts dedupes a refresh PER
  // INSTANCE, and Fluid Compute runs many; a stale dashboard key can therefore fan
  // one full re-page out per cold instance that happens to be asked for it. Under
  // the interactive class those re-pages would keep spending right up to 90% and
  // blank the screen they were refreshing. Under the background class they stop at
  // 60% and the stale value — which is still served, verbatim, with its own honest
  // "Stats updated" stamp — carries on being served.
  const scoped = asBackgroundRefresh(task);
  try {
    after(scoped);
  } catch {
    void scoped().catch(() => {});
  }
}

/**
 * Wrap a stale-while-revalidate refresh so its Dentally reads spend from the
 * BACKGROUND class. Named and exported so the property can be asserted directly
 * rather than inferred from the scheduler it is used by.
 */
export function asBackgroundRefresh(task: () => Promise<void>): () => Promise<void> {
  return () => runWithDentallyPriority("background", task);
}

// Null under VITEST so the unit suite exercises the REAL reads uncached, exactly as
// before this cache existed. A test that wants to exercise the cache MECHANISM
// through this file injects an active one with __setDisplayCacheForTests.
let displayCache: DisplayCache | null = process.env.VITEST
  ? null
  : createDisplayCache({ store: supabaseDisplayCacheStore(), scheduleBackground: afterScheduler });

/**
 * TEST SEAM. Swap in a display cache (e.g. one backed by inMemoryDisplayCacheStore)
 * so the wiring in THIS file can be driven under VITEST, where displayCache is null
 * by default. Pass null to restore the pass-through (compute-live) behaviour. Only
 * for tests; production builds the singleton above.
 */
export function __setDisplayCacheForTests(cache: DisplayCache | null): void {
  displayCache = cache;
}

/**
 * Exported so ONE caller can wrap several reads in a SINGLE cache entry.
 *
 * lib/patient/record.ts uses this to put the by-id read and the detail read behind
 * one key: the patient record has two surfaces (the page and the quick view) and
 * they must never disagree about a figure, which they would if each read through a
 * cache with its own TTL. Everything else in this file should keep using cachedRead
 * per read, as it does below.
 *
 * `clientId` is the TENANCY key -- it is embedded in the L1 map key AND the shared
 * L2 row and its WHERE clause, so a read for one practice can never be answered with
 * another's cached blob. Pass the client that owns `siteIds` (clientIdForSites);
 * null when it cannot be resolved unambiguously, which keeps the read L1-only and
 * out of the shared L2.
 */
export async function cachedRead<T>(
  clientId: string | null,
  key: string,
  fn: () => Promise<T>,
  ttlMs = READ_CACHE_TTL_MS,
): Promise<T> {
  // VITEST default / cache disabled: compute live (no cross-test cache pollution).
  if (!displayCache) return fn();
  return displayCache.cachedRead(clientId, key, fn, ttlMs);
}

/**
 * Write a value straight into the shared L2 under (clientId, key), bypassing the
 * read path. This is the PRE-WARM seam: the pre-warm cron computes an expensive
 * DISPLAY read once (a true cold compute) and stamps it into L2 with a LONG ttl —
 * one that outlives the cron interval — so the row stays FRESH between runs and a
 * normal user read is a fresh L2 hit rather than a stale-serve+refresh. `clientId`
 * is the tenancy key: it is embedded in the L1 key AND the L2 row, so a pre-warm for
 * one practice can never land in another's bucket. No-op when the cache is disabled
 * (VITEST default), like every other read here.
 */
export async function writeDisplayCache(
  clientId: string | null,
  key: string,
  value: unknown,
  ttlMs: number,
): Promise<void> {
  if (!displayCache) return;
  await displayCache.setCached(clientId, key, value, ttlMs);
}

// ---------------------------------------------------------------------------
// A REFUSED READ MUST NOT BE CACHED  (the same rule the dashboard assembly follows)
// ---------------------------------------------------------------------------
//
// Every read below that degrades a failure into an empty array / null does so INSIDE
// a cachedRead, so whatever it returns is promoted into the shared L2 as the answer
// for the rest of the TTL — and, on a stale-while-revalidate refresh, promoted ON TOP
// of the good value that was being served. That is right for a real Dentally failure
// (there is nothing better to offer) and wrong for a BUDGET REFUSAL, which is the
// platform declining to spend quota while a perfectly good previous answer sits in
// the row it is about to overwrite. Worse, a refusal is not per-site: every site in
// the fan-out is refused at the same instant, so what gets cached is not a partial
// result but a completely blank one.
//
// The shape used below is: the UNCACHED compute re-throws the refusal
// (rethrowIfBudgetRefused, ./client) so no promote can happen, and the PUBLIC entry
// point catches it OUTSIDE the cache and answers with exactly the degraded value it
// answered with before. Callers see no new failure mode; the cache simply never
// learns about it.
//
// Three reads in this file already got this right and are unchanged:
// listAppointmentsSafe (promotes only when failedSiteIds is empty),
// listSitePractitionersSafe and listDiaryAvailabilitySafe (promote only when
// !result.failed). A refusal sets their failure flags, so they already decline to
// cache it.

/**
 * Turn a BUDGET REFUSAL into `fallback` — the value this read already degraded to —
 * and let every other error through untouched.
 *
 * Use it on the CACHED side of a read whose uncached half re-throws refusals, so the
 * refusal is absorbed after the cache has already declined to promote it.
 */
function degradeOnBudgetRefusal<T>(label: string, fallback: T): (err: unknown) => T {
  return (err: unknown): T => {
    if (!(err instanceof DentallyBudgetExceededError)) throw err;
    console.warn(
      `[dentally] ${label}: the shared Dentally budget refused this read. Serving the ` +
        `degraded value WITHOUT caching it, so the good cached value survives and the ` +
        `next read retries.`,
    );
    return fallback;
  };
}

/** All patients across the given sites. The 3 sites are paged CONCURRENTLY (peak
 *  concurrency = site count), so wall-clock is the slowest single site, not the sum.
 *  /v1/patients DOES honour site_id server-side, so this stays a per-site scan.
 *  `opts.maxPages` bounds the per-site page scan (e.g. the Patients page shows a fast
 *  first ~300); callers that omit it keep the full scan (name resolution, sync, etc.). */
export function listPatients(siteIds: string[], opts?: { maxPages?: number }): Promise<PatientRecord[]> {
  const key = `patients:${[...siteIds].sort().join("|")}:${opts?.maxPages ?? "all"}`;
  return cachedRead(
    clientIdForSites(siteIds),
    key,
    () => _listPatientsUncached(siteIds, opts?.maxPages),
  ).catch(degradeOnBudgetRefusal("listPatients", [] as PatientRecord[]));
}
async function _listPatientsUncached(siteIds: string[], maxPages?: number): Promise<PatientRecord[]> {
  const client = dentallyFromEnv();
  const perSite = await Promise.all(
    siteIds.map(async (siteId) => {
      try {
        // `.rows`: the truncation is DISCARDED HERE, at the call site and in the
        // open, rather than by a pager that never offered it. The bound is the point
        // on a display read — see the header above.
        const { rows } = await pageToCeiling(
          (page, perPage) =>
            client.listPatients({ siteId: dentallySiteId(siteId), page, perPage }).then((res) => res.patients ?? []),
          PER_PAGE,
          maxPages ?? MAX_PAGES,
        );
        return rows.map((p) => toPatient(p as Record<string, unknown>));
      } catch (err) {
        // A REFUSAL IS NOT A FAILED SITE: it propagates so the empty book is never
        // promoted over the good cached one. listPatients absorbs it above.
        rethrowIfBudgetRefused(err);
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
  return cachedRead(
    clientIdForSites(siteIds),
    key,
    () => _searchPatientsUncached(siteIds, q),
    30_000,
  ).catch(degradeOnBudgetRefusal("searchPatients", [] as PatientRecord[]));
}
async function _searchPatientsUncached(siteIds: string[], query: string): Promise<PatientRecord[]> {
  const client = dentallyFromEnv();
  const perSite = await Promise.all(
    siteIds.map(async (siteId) => {
      try {
        const { rows } = await pageToCeiling(
          (page, perPage) =>
            client
              .listPatients({ siteId: dentallySiteId(siteId), query, page, perPage })
              .then((res) => res.patients ?? []),
          PER_PAGE,
          SEARCH_MAX_PAGES,
        );
        return rows.map((p) => toPatient(p as Record<string, unknown>));
      } catch (err) {
        rethrowIfBudgetRefused(err); // never cache an empty result set that we refused to fetch
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
  // The 5-minute TTL is what makes this one matter: a refusal-shaped null would sit
  // on the headline patient count for five minutes over a figure that was correct.
  return cachedRead(
    clientIdForSites(siteIds),
    key,
    () => _countPatientsUncached(siteIds),
    300_000,
  ).catch(degradeOnBudgetRefusal<number | null>("countPatients", null));
}
async function _countPatientsUncached(siteIds: string[]): Promise<number | null> {
  const client = dentallyFromEnv();
  const totals = await Promise.all(
    siteIds.map(async (siteId) => {
      try {
        return await client.countPatients(dentallySiteId(siteId));
      } catch (err) {
        // A refusal on ANY site propagates: a partial sum is a WRONG headline count,
        // and caching it for five minutes would state it as fact.
        rethrowIfBudgetRefused(err);
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
 *  patient list and never 404s a patient just because they sit past page 1.
 *
 *  WRAPPED IN React cache(), which is a REQUEST-SCOPED dedup and not a cache with a
 *  lifetime. It collapses the repeats WITHIN one render, and the patient record has
 *  three of them on a single page load:
 *
 *    1. the layout's getPatientRecordInScope resolves the patient purely to learn
 *       which site they are in, so the site-switcher scope can be checked;
 *    2. the page's RecordTabContent does the SAME resolve again, because a layout
 *       cannot hand data to its children in the App Router;
 *    3. resolve() inside the 30s record entry reads the patient once more.
 *
 *  Three live `GET /v1/patients/:id` round trips against the shared Dentally rate
 *  budget to answer one question, on every record open and every hover-prefetch of a
 *  sibling tab. This makes it one. It is also why the prefetching added to the tab
 *  strip is affordable at all: a prefetch pays the same three otherwise.
 *
 *  WHY NOT A CROSS-REQUEST TTL like the display reads above. This read's result
 *  decides `patient.siteId`, which is the input to the caller's scope check, and the
 *  cache key it would need (a bare patient id) carries no tenancy — exactly the shape
 *  the display cache had to have clientId added to. cache() has no such surface: it
 *  lives and dies inside one server render, so there is no cross-request staleness
 *  and nothing to key wrong. The 30s record entry above already provides the
 *  cross-request layer, keyed properly.
 *
 *  The contract is UNCHANGED — null on any failure, including a budget refusal — and
 *  twenty-odd callers depend on it. Note that a null is memoised for the rest of the
 *  render too, which is correct: two reads of a missing patient in one render must
 *  not disagree about whether they found them.
 */
export const getPatientById = cache(
  async (patientId: string): Promise<PatientRecord | null> => {
    try {
      return await getPatientByIdOrRefusal(patientId);
    } catch {
      // Only a budget refusal reaches here (everything else is already absorbed and
      // logged below).
      return null;
    }
  },
);

/**
 * getPatientById, except that a BUDGET REFUSAL propagates instead of becoming `null`.
 *
 * For the one caller that is INSIDE a cache entry and must not let a refusal be
 * promoted: the debtor fan-out in _listOutstandingUncached. There, "null" means the
 * patient could not be resolved and their balance is silently dropped from the
 * practice's outstanding total — so a refusal that answered null for every debtor
 * would cache a total missing most of the money owed.
 */
async function getPatientByIdOrRefusal(patientId: string): Promise<PatientRecord | null> {
  const client = dentallyFromEnv();
  try {
    const res = await client.getPatient(patientId);
    const p = res.patient;
    if (!p || typeof p !== "object") return null;
    return toPatient(p as Record<string, unknown>);
  } catch (err) {
    console.error(`[dentally] getPatient(${patientId}) failed`, err);
    rethrowIfBudgetRefused(err);
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
          const { rows } = await pageToCeiling(
            (page, perPage) =>
              client
                .listAppointments({ siteId: dentallySiteId(siteId), fromDate: from || undefined, toDate: to || undefined, page, perPage })
                .then((res) => res.appointments ?? []),
            PER_PAGE,
            MAX_PAGES,
          );
          return rows.map((a) => toAppointment(a as Record<string, unknown>, siteId));
        } catch (err) {
          // Unlike listAppointmentsSafe below, this feed has no `failed` flag to stop
          // the promote, so the refusal has to propagate instead. listAppointments
          // absorbs it after the cache has declined to cache it.
          rethrowIfBudgetRefused(err);
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
    clientIdForSites(siteIds),
    `appts:${siteIds.join("|")}:${from}:${to}`,
    () => listAppointmentsCached(siteIds.join("|"), from, to),
  ).catch(degradeOnBudgetRefusal("listAppointments", [] as AppointmentRecord[]));
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
  const clientId = clientIdForSites(siteIds);

  if (displayCache) {
    const hit = await displayCache.getCached<AppointmentsRead>(clientId, cacheKey);
    if (hit) return hit;
  }

  const client = dentallyFromEnv();
  const failedSiteIds: string[] = [];
  const perSite = await Promise.all(
    siteIds.map(async (siteId) => {
      try {
        const { rows } = await pageToCeiling(
          (page, perPage) =>
            client
              .listAppointments({
                siteId: dentallySiteId(siteId),
                fromDate: from || undefined,
                toDate: to || undefined,
                page,
                perPage,
              })
              .then((res) => res.appointments ?? []),
          PER_PAGE,
          MAX_PAGES,
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
  // empty-diary lie as the all-sites-failed case, just narrower. Only a CLEAN read
  // reaches the shared L2, so a failure on one instance can never poison another's.
  if (displayCache && failedSiteIds.length === 0) {
    await displayCache.setCached(clientId, cacheKey, result, READ_CACHE_TTL_MS);
  }
  return result;
}

/** The three cached read families whose rows a confirmed appointment write can make
 *  stale: the two appointment feeds and the diary's availability grid. */
const APPOINTMENT_CACHE_PREFIXES = ["apptssafe:", "appts:", "diaryavail:"] as const;

/** True when an appointment-family cache key's embedded site set intersects `wanted`.
 *  Every such key is `<prefix>:<siteOrSites>:<...>` and site ids carry no colon, so
 *  the first segment after the first colon is the site part (`a|b|c` for the feeds,
 *  a single id for diaryavail). Exported for the invalidation pin. */
export function appointmentKeyIntersectsSites(key: string, wanted: Set<string>): boolean {
  const firstColon = key.indexOf(":");
  if (firstColon === -1) return false;
  const sitePart = key.slice(firstColon + 1).split(":")[0] ?? "";
  return sitePart.split("|").some((s) => wanted.has(s));
}

/**
 * Drop every cached appointment window whose site set intersects `siteIds`, across
 * BOTH cache layers.
 *
 * WHY THIS HAS TO EXIST. The appointment feeds cache a successful window for 60s, and
 * a router.refresh() straight after a CONFIRMED appointment move would otherwise
 * repaint the OLD time for up to a minute. To the person who just moved it that reads
 * as a silent revert: the very failure the read-back confirmation exists to prevent,
 * produced by the cache that makes the page fast. The move route calls this after a
 * confirmed write, and only then may the board refresh. Now that the cache is
 * CROSS-INSTANCE, this must bust the shared L2 too, or the stale row survives on
 * every OTHER instance for the rest of the TTL.
 *
 * L1 is INTERSECTION-precise (the diary reads one site at a time, but Home and the
 * daily brief read all three in one key, and that combined entry holds the same stale
 * row). L2 is busted per read-family for the whole client -- over-invalidating within
 * one practice, which only forces a recompute and never yields a wrong answer.
 */
export async function invalidateAppointmentsCache(siteIds: string[]): Promise<void> {
  if (siteIds.length === 0 || !displayCache) return;
  const wanted = new Set(siteIds);
  await displayCache.invalidate(clientIdForSites(siteIds), {
    prefixes: APPOINTMENT_CACHE_PREFIXES,
    l1Predicate: (key) => appointmentKeyIntersectsSites(key, wanted),
  });
}

/**
 * The raw availability rows for one site's practitioners across a day range.
 *
 * This is the diary's "who is actually working" read, and it is the honest source:
 * our own opening-hours config has never been checked against the practice and is
 * already contradicted by live windows running past its configured close.
 *
 * WHAT THE ROWS ACTUALLY ARE, measured against live Dentally on 2026-08-21: they
 * are the practitioner's FREE GAPS inside their configured sessions, not the
 * sessions themselves. A clinician booked solid from 09:30 to 17:50 with a
 * session ending at 18:00 returned exactly one row, 17:50-18:00; a clinician
 * booked solid all day returned none at all. Nothing outside their sessions ever
 * came back, so the rows are bounded by real working time.
 *
 * That is why workingSpans() UNIONS these windows with the day's own booked
 * appointments (see working-spans.ts) and why it MUST: taken alone, availability
 * says a fully booked clinician is not working.
 *
 * Four decisions worth stating:
 *  - THE WINDOW SENT IS NOT THE WINDOW ASKED FOR. Dentally rejects a start that
 *    is not strictly in the future and a span of 24 hours or less, so the request
 *    is clamped and widened (diaryAvailabilityRequest) and the answer is trimmed
 *    back to the requested days (availabilityRowsWithinDays). Sending the plain
 *    day range 400d on EVERY diary read at EVERY site, which is the bug this
 *    exists to prevent coming back.
 *  - A day that has ENTIRELY ENDED is unanswerable, not empty. No call is issued
 *    for it and it is named in `unanswerableDayKeys`, because "Dentally cannot
 *    tell us who worked last Monday" and "nobody worked last Monday" are
 *    different sentences and the grid paints them differently.
 *  - TODAY IS PARTLY unanswerable for the same reason, every afternoon: the
 *    clamped start eats the hours that had already gone by, so `answerableFromMin`
 *    names the minute the answer actually begins. Without it a morning-only
 *    clinician with nothing booked reads as "Not working" from lunchtime onwards.
 *  - NO `duration` is sent. It is a FILTER, not a shape: `duration=30` dropped
 *    the measured 10-minute gap entirely. The diary wants the raw WINDOW so it
 *    can shade a session; chunking it into bookable slots at the parse seam
 *    (which the booking path does) throws away exactly the shape the grid needs.
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

/** What is STORED. Deliberately not the returned shape: see the cache read. */
interface CachedAvailability {
  rows: unknown[];
  failed: boolean;
}

export interface DiaryAvailabilityRead {
  rows: unknown[];
  failed: boolean;
  /**
   * Requested days Dentally cannot answer for because they have already ended.
   * NOT a failure: no call was issued for them and none ever could be. The column
   * says so in its own words rather than claiming the practice was shut.
   */
  unanswerableDayKeys: string[];
  /**
   * Per requested day, the London wall-minute the answer BEGINS at. Absent means
   * the whole day was asked about. Present means the request had to be clamped
   * into the future and the earlier part of that day -- this morning, every
   * afternoon -- is missing from `rows` because nobody could ask, not because
   * nobody was working. See diaryAvailabilityRequest.
   */
  answerableFromMin: Record<string, number>;
}

export async function listDiaryAvailabilitySafe(
  args: {
    siteId: string;
    practitionerIds: readonly string[];
    fromDayKey: string;
    toDayKey: string;
  },
  opts: ThroughClient = {},
): Promise<DiaryAvailabilityRead> {
  const ids = [...args.practitionerIds].filter((id) => id !== "");
  if (ids.length === 0) return { rows: [], failed: false, unanswerableDayKeys: [], answerableFromMin: {} };

  // THE WINDOW IS DECIDED BEFORE THE CACHE IS TOUCHED. A range that has entirely
  // ended can never be answered, so it costs nothing and is never stored: the
  // answer is a property of the calendar, not of Dentally.
  const window = diaryAvailabilityRequest({
    fromDayKey: args.fromDayKey,
    toDayKey: args.toDayKey,
    nowMs: Date.now(),
  });
  if (window === null) {
    return {
      rows: [],
      failed: false,
      unanswerableDayKeys: dayKeysBetween(args.fromDayKey, args.toDayKey),
      // Every requested day is unanswerable outright, so there is no day with a
      // part-answer to report.
      answerableFromMin: {},
    };
  }

  const cacheKey = `diaryavail:${args.siteId}:${[...ids].sort().join("|")}:${args.fromDayKey}:${args.toDayKey}`;
  const clientId = clientIdForSites([args.siteId]);
  // A caller supplying its OWN client (the write-guard path) bypasses the cache in
  // both directions -- see the ThroughClient note on listSitePractitionersSafe.
  const useCache = displayCache && !opts.client;
  if (useCache) {
    // ONLY THE ROWS COME OUT OF THE CACHE. Which days are past is derived from
    // `now`, and a cache -- shared cross-instance and outliving a deploy -- is
    // not the authority on the time. Recomputing it also means the stored shape
    // never had to change, so entries written by the previous version are still
    // read correctly rather than yielding an undefined list on a live diary.
    const hit = await displayCache!.getCached<CachedAvailability>(clientId, cacheKey);
    if (hit) {
      return {
        rows: hit.rows,
        failed: hit.failed,
        unanswerableDayKeys: window.unanswerableDayKeys,
        // RECOMPUTED FROM `now` for the same reason, and it can only ever move
        // FORWARD as the entry ages: an hour-old entry really does hold rows for
        // a window that has since closed, and reporting the fresher, later minute
        // declines to claim hours we would rather not have to stand behind.
        answerableFromMin: window.answerableFromMin,
      };
    }
  }

  const client = opts.client ?? dentallyFromEnv();
  let result: CachedAvailability;
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
        startTime: window.startTime,
        finishTime: window.finishTime,
        page,
        perPage: AVAILABILITY_PER_PAGE,
      });
      const batch = Array.isArray(res.availability) ? res.availability : [];
      // The days asked for are a subset of the window SENT, so each page is
      // trimmed before it is kept.
      const wanted = new Set(availabilityRowsWithinDays(batch, args.fromDayKey, args.toDayKey));
      // `added` COUNTS THE UNTRIMMED PAGE, deliberately. It is the walk's
      // end-of-pages signal (an endpoint that ignores `page` repeats itself and
      // contributes nothing new), and that is a fact about Dentally's paging, not
      // about our day range: counting only the trimmed rows would end the walk on
      // the first page that happened to be all tomorrow and silently truncate the
      // days we did ask for.
      let added = 0;
      for (const raw of batch) {
        const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
        const key = `${String(r.practitioner_id ?? "")}|${String(r.start_time ?? "")}|${String(r.finish_time ?? "")}`;
        if (seen.has(key)) continue;
        seen.add(key);
        added += 1;
        if (wanted.has(raw)) rows.push(raw);
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

  if (useCache && !result.failed) {
    await displayCache!.setCached(clientId, cacheKey, result, READ_CACHE_TTL_MS);
  }
  // A FAILED read reports NO unanswerable days. The column must hatch as "we
  // could not find out", not carry the calmer "that date has passed" wording over
  // an outage we do not understand.
  return {
    ...result,
    unanswerableDayKeys: result.failed ? [] : window.unanswerableDayKeys,
    // Same rule: a failed read softens nothing. The column hatches as "we could
    // not find out", which is already the most cautious thing it can say.
    answerableFromMin: result.failed ? {} : window.answerableFromMin,
  };
}

export interface PlanRecord {
  name: string;
  planned: number;
  outstanding: number;
  acceptedAt: string | null;
}

/** Defined with the /v1/notes shape rules it belongs to, and re-exported so every
 *  existing `import type { NoteRecord } from "@/lib/dentally/read"` still works. */
export type { NoteRecord };

/**
 * Whether each of the four per-patient Dentally reads actually succeeded.
 *
 * Every one of them catches to an empty array so a single outage cannot blank the
 * whole record. Without this flag that resilience becomes a LIE on a clinical
 * screen: a failed notes read renders as "No clinical notes in Dentally", which a
 * clinician reads as a fact about the patient rather than a fact about the network.
 * "none" and "we could not read it" are different clinical statements and this is
 * what lets the panels tell them apart.
 */
export interface ReadHealth {
  appointments: "ok" | "failed";
  plans: "ok" | "failed";
  notes: "ok" | "failed";
  invoices: "ok" | "failed";
}

export interface PatientDetail {
  appointments: AppointmentRecord[];
  plans: PlanRecord[];
  notes: NoteRecord[];
  lifetimeSpend: number;
  /** Balance still owed across this patient's unpaid invoices (0 if all settled). */
  outstanding: number;
  /** Money the practice owes THIS patient, as a positive number (0 in the normal
   *  case). An overpayment at reception is a real figure Dentally's own account
   *  screen shows, and clamping it to zero printed "Balance £0.00" instead. */
  credit: number;
  /** Total invoiced across this patient's whole invoice history. Dentally's own
   *  account card prints it beside the balance, so we hold it rather than making a
   *  panel add up figures of its own. */
  totalInvoiced: number;
  /** The raw invoice rows behind the two figures above, mapped to the columns
   *  Dentally's Account tab prints. See InvoiceRecord for what is and is not real. */
  invoices: InvoiceRecord[];
  reads: ReadHealth;
}

/**
 * One invoice, in the shape Dentally's own Account tab lists them.
 *
 * PROVENANCE, because half of Dentally's columns have no source here:
 *   - `reference`, `status`, `balance` and `total` are read from the invoice payload
 *     the outstanding scan already parses, so they are as trustworthy as that scan.
 *   - `date` is TENTATIVE. The live field name is unverified and is read defensively
 *     as created_at ?? date ?? issued_at, exactly as listOutstanding does; the local
 *     mock's invoices carry no date at all, so null is a normal result.
 *   - Dentally also prints Summary, Practitioners and Location. NOTHING in this repo
 *     reads them off an invoice, so they are deliberately absent here rather than
 *     invented: the Account tab keeps those columns and renders a dash with one
 *     footnote, which is the honest rendering of a column we cannot fill.
 */
export interface InvoiceRecord {
  id: string;
  /** Dentally's human invoice reference, falling back to the id when absent. */
  reference: string;
  status: string | null;
  /** ISO-ish string as Dentally returned it, or null. Tentative: see above. */
  date: string | null;
  /** Still owed on this invoice (0 when settled). */
  balance: number;
  /** Gross total invoiced. */
  total: number;
}

/** Full record for one patient: appointment history, treatment plans, notes, lifetime spend.
 *  Cached (short TTL) so re-opening the same record is instant. */
export function getPatientDetail(patientId: string, siteId: string): Promise<PatientDetail> {
  return cachedRead(
    clientIdForSites([siteId]),
    `patientdetail:${siteId}:${patientId}`,
    () => _getPatientDetailUncached(patientId, siteId),
    30_000,
  ).catch(degradeOnBudgetRefusal("getPatientDetail", unavailablePatientDetail()));
}

/**
 * The patient record with EVERY read reported as failed and no figures invented.
 *
 * Byte-identical to what the four per-read catches produced while they absorbed a
 * budget refusal, so the panels render exactly the "we could not read this" they
 * rendered before — a clinician is never shown "No clinical notes in Dentally" for a
 * read the platform declined to make. The difference is only that this value is never
 * CACHED: it is built at the entry point, after the cache has already declined to
 * promote the refusal. Exported for lib/patient/record.ts, which owns its own entry.
 */
export function unavailablePatientDetail(): PatientDetail {
  return {
    appointments: [],
    plans: [],
    notes: [],
    lifetimeSpend: 0,
    outstanding: 0,
    credit: 0,
    totalInvoiced: 0,
    invoices: [],
    reads: { appointments: "failed", plans: "failed", notes: "failed", invoices: "failed" },
  };
}
/** The detail read with NO cache of its own, for a caller that is already inside a
 *  cache entry of its own (lib/patient/record.ts). Prefer getPatientDetail. */
export function getPatientDetailUncached(patientId: string, siteId: string): Promise<PatientDetail> {
  return _getPatientDetailUncached(patientId, siteId);
}
async function _getPatientDetailUncached(patientId: string, siteId: string): Promise<PatientDetail> {
  const client = dentallyFromEnv();

  // Each read reports whether it actually succeeded, so an outage is never rendered
  // as "this patient has none of that". Flipped in the catch, read into `reads` below.
  const health: ReadHealth = { appointments: "ok", plans: "ok", notes: "ok", invoices: "ok" };

  // A BUDGET REFUSAL IS NOT ONE OF THOSE OUTAGES. Absorbed, it produced a complete,
  // all-"failed" record - which getPatientDetail's own 30-second entry and
  // lib/patient/record.ts's `patientrecord:` entry then promoted over the good one,
  // and a reader's stale-while-revalidate refresh (BACKGROUND class, refused at 60%)
  // is exactly the caller that hits it. Captured here rather than thrown from inside
  // a .catch, so all four reads still settle and the health flags are still filled;
  // the throw happens once, below, before anything can be returned or cached.
  const refusals: DentallyBudgetExceededError[] = [];
  const noteRefusal = (err: unknown): void => {
    if (err instanceof DentallyBudgetExceededError) refusals.push(err);
  };

  // includeCancelled = true, and PAGED.
  //
  // Two defects fixed at once, both of which matter more here than anywhere else:
  //   1. The client defaults cancelled=false, so a patient's OWN record hid every
  //      cancellation and every did-not-attend. A clinical record that hides a
  //      patient's DNAs is worse than no record: it is the single most operationally
  //      and commercially material thing on the tab, and the front desk needs it
  //      before they offer a prime slot.
  //   2. This was the only per-patient read here that was a single unpaged 100-row
  //      call, so a long-standing patient's history silently stopped at 100 rows with
  //      no marker of any kind. The bounded pager loops until a short page.
  // Bounded at 10 pages (1,000 appointments) because this is one patient, not a book.
  const apptsP = pageToCeiling(
    (page, perPage) =>
      client
        .getPatientAppointments(patientId, page, perPage, true)
        .then((res) => res.appointments ?? []),
    PER_PAGE,
    10,
  )
    .then(({ rows }) => rows.map((a) => toAppointment(a as Record<string, unknown>, siteId)))
    .catch((err: unknown) => {
      noteRefusal(err);
      health.appointments = "failed";
      return [] as AppointmentRecord[];
    });

  // Query THIS patient's plans directly (patient_id) instead of paging the whole
  // group's treatment_plans (up to 100 calls) to filter one patient out — that was
  // ~100 Dentally calls on every record open. A patient has few plans, so a small
  // bound is plenty; the client-side filter stays as a safety net in case Dentally
  // ignores patient_id the way it ignores site_id.
  const plansP = pageToCeiling(
    (page, perPage) =>
      client
        .listTreatmentPlans({ siteId: dentallySiteId(siteId), patientId, page, perPage })
        .then((res) => res.treatment_plans ?? []),
    PER_PAGE,
    5,
  )
    .then(({ rows: plans }) =>
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
    .catch((err: unknown) => {
      noteRefusal(err);
      health.plans = "failed";
      return [] as PlanRecord[];
    });

  // PAGED, for the same reason the appointment read above is. This is the ONE stream
  // on the record where a dropped row can be an allergy or a medication warning, and
  // it was a single unpaged call: a patient of fifteen years with 200 clinical notes
  // rendered the most recent page as if it were the complete history, with no count
  // and no truncation marker.
  //
  // The path is /v1/notes. It used to be /v1/patient_notes, which does not exist on
  // real Dentally, so this read 404'd on every live patient and the tab told every
  // clinician "we could not read Dentally's clinical notes just now" — forever. Both
  // the envelope reader and the row mapper live in ./notes-shape and THROW on a shape
  // they do not recognise, which lands in the catch below as health.notes = "failed".
  // That is deliberate: for this stream, "we could not read it" is the only honest
  // thing to say about a response we did not understand.
  const notesP = pageToCeiling(
    (page, perPage) => client.getPatientNotes(patientId, page, perPage).then(notesFromEnvelope),
    PER_PAGE,
    10,
  )
    .then(({ rows }) => toNoteRecords(rows))
    .catch((err: unknown) => {
      noteRefusal(err);
      health.notes = "failed";
      return [] as NoteRecord[];
    });

  // PAGED. Every money figure on this record - Balance, Lifetime spend, Total
  // invoiced, Total paid and the whole Account table - is a reduction over this
  // array, and it was a single unpaged 100-row call. A truncated array does not fail
  // any honesty guard: reads.invoices stays "ok" and a wrong balance is printed in
  // red at the top of the record as fact.
  const invoicesP = pageToCeiling(
    (page, perPage) => client.getPatientInvoices(patientId, page, perPage).then((res) => res.invoices ?? []),
    PER_PAGE,
    10,
  )
    .then(({ rows }) => rows.map((inv) => inv as Record<string, unknown>))
    .catch((err: unknown) => {
      noteRefusal(err);
      health.invoices = "failed";
      return [] as Record<string, unknown>[];
    });

  const [appointments, plans, notes, invoices] = await Promise.all([apptsP, plansP, notesP, invoicesP]);
  // Propagate, so neither cache entry above this one promotes a record that says the
  // practice could not read its own patient when in fact nobody asked Dentally.
  if (refusals.length > 0) throw refusals[0];
  const lifetimeSpend = invoices.reduce((sum, r) => sum + invoicePaid(r), 0);
  const outstanding = invoices.reduce((sum, r) => sum + invoiceOutstanding(r), 0);
  const credit = invoices.reduce((sum, r) => sum + invoiceCredit(r), 0);
  const totalInvoiced = invoices.reduce((sum, r) => sum + num(r.amount ?? r.total ?? r.gross ?? r.value), 0);
  const invoiceRows: InvoiceRecord[] = invoices.map((r) => ({
    id: String(r.id ?? ""),
    reference: str(r.reference) ?? str(r.number) ?? String(r.id ?? ""),
    status: str(r.status) ?? str(r.state),
    // Tentative field name; read exactly as listOutstanding reads it.
    date: str(r.created_at) ?? str(r.date) ?? str(r.issued_at),
    balance: invoiceOutstanding(r),
    total: num(r.amount ?? r.total ?? r.gross ?? r.value),
  }));
  invoiceRows.sort((a, b) => ((a.date ?? "") < (b.date ?? "") ? 1 : -1)); // newest first
  appointments.sort((a, b) => (a.start < b.start ? 1 : -1)); // newest first
  return {
    appointments,
    plans,
    notes,
    lifetimeSpend,
    outstanding,
    credit,
    totalInvoiced,
    invoices: invoiceRows,
    reads: health,
  };
}

export interface OutstandingRead {
  rows: OutstandingRecord[];
  /**
   * True when a site's unpaid-invoice scan exhausted OUTSTANDING_MAX_PAGES on full
   * pages without ever reaching a short page or the ignored-filter signature. The
   * outstanding total is then a FLOOR, not a complete figure: balances on invoices
   * past the page cap are not included. The Payments page surfaces this so a
   * partial total is never presented as the whole; false on any scan that
   * terminated cleanly on a short page (the normal case). An errored site is logged
   * and skipped as before and does NOT set this — it is a transient failure the
   * next 60s refresh may clear, distinct from a structural cap.
   */
  truncated: boolean;
}

/** Outstanding balances across the given sites plus whether the invoice scan hit its
 *  page cap (so the caller can tell a complete total from a floor). Shares the same
 *  60s cache entry as {@link listOutstanding}, so the two never double-scan. */
export function listOutstandingDetailed(siteIds: string[]): Promise<OutstandingRead> {
  return cachedRead(
    clientIdForSites(siteIds),
    outstandingCacheKey(siteIds),
    () => _listOutstandingUncached(siteIds),
    OUTSTANDING_TTL_MS,
  ).catch(
    // `truncated: true`, not false. The refusal means the scan is definitively
    // incomplete, and that is exactly what this flag is for: the Payments page then
    // presents the total as a FLOOR rather than as the practice's whole debt. Nothing
    // here is cached — the refusal already stopped the promote.
    degradeOnBudgetRefusal<OutstandingRead>("listOutstanding", { rows: [], truncated: true }),
  );
}

/** The exact L2 cache key the outstanding read uses. Shared with the pre-warm so the
 *  two can never drift onto different keys (a drift would warm a key nobody reads). */
function outstandingCacheKey(siteIds: string[]): string {
  return `outstanding:${[...siteIds].sort().join("|")}`;
}

/**
 * PRE-WARM the outstanding read for these sites: recompute it fresh (a true cold
 * scan, bypassing the read path) and stamp it into L2 under the read's own key with
 * `ttlMs`. Tenant-correct by construction (clientIdForSites is the key). Called only
 * by the pre-warm cron; a no-op when the cache is disabled.
 *
 * THE WRITE IS UNCONDITIONAL AND UNREACHABLE ON A REFUSAL, exactly as
 * prewarmPracticeDashboard's is. This runs in the BACKGROUND class, refused first at
 * 60% of the hour, so a refused run is the normal outcome of a busy afternoon; while
 * the scan absorbed the refusal, this line stamped "£0 outstanding, nothing owed by
 * anybody" over the real debtors book with a fresh TTL. The scan now throws first.
 */
export async function prewarmOutstanding(siteIds: string[], ttlMs: number): Promise<void> {
  const value = await _listOutstandingUncached(siteIds);
  await writeDisplayCache(clientIdForSites(siteIds), outstandingCacheKey(siteIds), value, ttlMs);
}

/** Outstanding balances across the given sites, one aggregated row per patient, from
 *  unpaid invoices (real Dentally holds the balance on invoices, not on plans). The
 *  rows half of {@link listOutstandingDetailed}, kept as its own export because the
 *  co-pilot and the daily brief consume the array directly. */
export function listOutstanding(siteIds: string[]): Promise<OutstandingRecord[]> {
  return listOutstandingDetailed(siteIds).then((read) => read.rows);
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
 *  Used for lifetime spend, which otherwise summed booleans (1/0) as pounds on live.
 *
 *  IT HONOURS THE SAME NON-DEBT STATUSES invoiceOutstanding does, which it did not.
 *  A written-off invoice normally carries amount_outstanding 0, so this returned the
 *  FULL GROSS as money received: a £900 course written off after a dispute printed
 *  "Total paid £900" and "Lifetime spend £900" for money the practice never saw,
 *  while Balance correctly read £0 from the same row. Two figures on one card
 *  disagreeing about whether an invoice is real, and the larger one is what a
 *  treatment coordinator uses to judge what this patient will spend. */
function invoicePaid(r: Record<string, unknown>): number {
  const status = str(r.status) ?? str(r.state);
  if (status && NON_DEBT_INVOICE_STATUSES.has(status)) return 0;
  if (typeof r.paid === "number") return num(r.paid); // mock/legacy shape
  const gross = num(r.amount ?? r.total);
  if (r.amount_outstanding != null) return Math.max(0, gross - num(r.amount_outstanding));
  return r.paid === true ? gross : 0;
}

/**
 * Money the practice owes on one invoice, as a POSITIVE number, or 0.
 *
 * invoiceOutstanding clamps at zero, which is right for the debtors scan (a credit is
 * not a debt and must never net one off) and wrong for a patient's own account
 * screen, where the clamp turned an overpayment into "Balance £0.00" in navy. Held as
 * its own figure so no existing sign test changes meaning.
 */
function invoiceCredit(r: Record<string, unknown>): number {
  const status = str(r.status) ?? str(r.state);
  if (status && NON_DEBT_INVOICE_STATUSES.has(status)) return 0;
  const raw = r.amount_outstanding ?? r.outstanding;
  if (raw == null) return 0;
  return Math.max(0, -num(raw));
}

async function _listOutstandingUncached(siteIds: string[]): Promise<OutstandingRead> {
  const client = dentallyFromEnv();
  // Set once any site exhausts the page cap on full pages: the total is then a
  // floor, and the caller says so rather than presenting the partial as the whole.
  let truncated = false;

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
    // AND A SHORT PAGE IS NOT PROOF THE WALK GOT EVERYTHING. /v1/invoices publishes
    // `meta.total` — exactly how many rows match `paid=false` for this request — and
    // this walk used to ignore it, so "the last page was short" was the ONLY evidence
    // it had that the practice's whole unpaid book was in hand. That is the same
    // inference reports/scan.ts's pageAll exists to stop being made about money: an
    // index that is not date-ordered, a filter the server may have applied loosely,
    // and a total printed on the Payments page as fact. The count is captured on page
    // one and checked at the end; falling short of it raises the SAME `truncated`
    // flag the page cap does, so the figure is disclosed as a floor rather than
    // presented as the book.
    let expected: number | null = null;
    let fetched = 0;
    try {
      for (let page = 1; page <= OUTSTANDING_MAX_PAGES; page += 1) {
        const res = await client.listInvoices({ siteId: dentallySiteId(siteId), page, perPage: PER_PAGE, paid: false });
        const invoices = res.invoices ?? [];
        // Page one carries the count. `fetched` is the RAW rows this site handed back,
        // not the deduped ones: the comparison has to be like for like with a total
        // that describes this request's own result set.
        if (page === 1) expected = metaTotal(res.meta);
        fetched += invoices.length;
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
        truncated = true;
        console.warn(
          `[dentally] listOutstanding: site ${siteId} hit the ${OUTSTANDING_MAX_PAGES}-page cap without a short page; ` +
            `the outstanding total may be understated (raise OUTSTANDING_MAX_PAGES or confirm the paid=false filter is honoured).`,
        );
      } else if (!ignoredFilter && expected !== null && fetched < expected) {
        // A SHORT PAGE THAT ARRIVED TOO EARLY. Dentally said how many unpaid invoices
        // match and handed back fewer, so rows are missing however tidily the walk
        // ended. NOT checked on the ignored-filter path: that break is deliberate —
        // an earlier site already covered the whole group — so `fetched` there is one
        // page of a total that describes the whole index, and comparing them would
        // manufacture a truncation out of the workaround.
        truncated = true;
        console.warn(
          `[dentally] listOutstanding: site ${siteId} ended on a short page holding ${fetched} of the ` +
            `${expected} unpaid invoices Dentally says match; the outstanding total is a FLOOR, not the book.`,
        );
      }
    } catch (err) {
      // THE FIRST THING A REFUSAL HITS. Page 1 of site 1 throws, so does every other
      // site, byPatient stays empty and this function used to return "nobody owes the
      // practice anything" — which the pre-warm then stamped over the real book and
      // the SWR refresh promoted over the good row. It propagates instead; the two
      // cached entry points above absorb it without caching it.
      rethrowIfBudgetRefused(err);
      console.error(`[dentally] listInvoices failed for site ${siteId}; skipping this site`, err);
    }
    if (ignoredFilter) break;
  }

  // Live-data fast path: nothing outstanding -> skip the (expensive) patient scan.
  if (byPatient.size === 0) return { rows: [], truncated };

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

  // The debtors the bounded book scan did not cover — patients on the shared group
  // index who belong to another practice, and this practice's own patients sorting
  // past the book's page cap (on the real base, 17k/site over a 100-page book that
  // reaches 10k, that is every debtor past the bound) — are resolved by a direct id
  // read. That fan-out USED TO BE SERIAL: one blocking round trip per miss, inside
  // the assembly loop. It now runs in bounded-concurrency chunks, so the round-trip
  // depth is misses/DEBTOR_RESOLVE_CHUNK rather than misses. Semantics are
  // unchanged: each miss is still resolved by its own id, and an unresolved miss is
  // still dropped below. The set of ids is byPatient's keys, so a patient is read at
  // most once however many invoices they carry.
  const misses = [...byPatient.keys()].filter((id) => !byId.has(id));
  const resolvedById = new Map<string, PatientRecord>();
  for (let i = 0; i < misses.length; i += DEBTOR_RESOLVE_CHUNK) {
    // THE LONGEST SWALLOWING LOOP IN THE PLATFORM. getPatientById catches every
    // error and returns null, `misses` is UNBOUNDED (on the real base it is every
    // debtor past the book scan's page cap — thousands), and an unresolved miss is
    // simply dropped below. So a budget refusal landing here used to keep asking,
    // once per debtor, for reads it never made — and each ask incremented the
    // practice's shared hourly counter. The refusal is sticky now
    // (src/lib/dentally/budget.ts) so it costs nothing, but walking the rest is
    // still pointless work and, worse, SILENT: every remaining debtor's balance
    // would drop out of the practice's outstanding total with nothing to say so.
    if (dentallyScopeRefused()) {
      const refusal = dentallyScopeRefusal();
      console.warn(
        `[dentally] listOutstanding: the shared Dentally budget refused this read after resolving ` +
          `${resolvedById.size} of ${misses.length} debtors; the outstanding total would be ` +
          `UNDERSTATED, so the read is ABANDONED rather than returned.`,
      );
      // IT USED TO SET truncated AND `break`, RETURNING THE PARTIAL. That was right
      // when the only consumer was a sweep reading the array, and wrong the moment
      // this value is CACHED: prewarmOutstanding (background, so this is exactly the
      // scope that gets refused) would stamp a book missing most of the practice's
      // debtors over the complete one, and the SWR refresh would promote the same.
      // Throwing is what stops both promotes; the two cached entry points then answer
      // with the honest `{ rows: [], truncated: true }` and cache nothing.
      throw new DentallyBudgetExceededError(
        refusal?.priority ?? "background",
        refusal?.limit ?? 0,
        "/v1/patients/:id (outstanding debtor resolve)",
      );
    }
    const chunk = misses.slice(i, i + DEBTOR_RESOLVE_CHUNK);
    // getPatientByIdOrRefusal, NOT getPatientById: the swallowing variant answers
    // `null` for a refusal, and a null debtor is DROPPED below. Outside a priority
    // scope dentallyScopeRefused() above is always false, so without this a refused
    // reader-path scan would quietly cache an outstanding total missing every debtor
    // the book scan did not reach. A refusal here propagates and is never cached.
    const found = await Promise.all(chunk.map((id) => getPatientByIdOrRefusal(id)));
    chunk.forEach((id, j) => {
      const rec = found[j];
      if (rec) resolvedById.set(id, rec);
    });
  }

  const out: OutstandingRecord[] = [];
  for (const [patientId, agg] of byPatient) {
    const patient = byId.get(patientId) ?? resolvedById.get(patientId);
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
  return { rows: out.sort((a, b) => b.outstanding - a.outstanding), truncated };
}
