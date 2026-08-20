import {
  consumeDentallyBudget,
  currentDentallyPriority,
  DENTALLY_HOURLY_LIMIT,
  type DentallyPriority,
} from "./budget";

type FetchImpl = typeof fetch;

export class DentallyError extends Error {
  constructor(public status: number, message: string) {
    super(`Dentally ${status}: ${message}`);
  }
}

interface Opts {
  apiKey: string;
  baseUrl: string;
  fetchImpl?: FetchImpl;
  userAgent?: string;
  /**
   * Refuse every non-GET on this client, throwing before the request is built.
   * See assertWritable below for why a comment was not enough.
   *
   * DEFAULTS TO TRUE when omitted. A client that writes must say so, in writing,
   * at the point it is built — see the constructor.
   */
  readOnly?: boolean;
  /**
   * Which slice of the practice's hourly Dentally budget this client's reads spend
   * (see ./budget.ts). OMIT IT unless this client is used from ONE class only: the
   * default is the AMBIENT class of whatever execution scope the read happens in,
   * which is what lets a helper shared by a dashboard and an hourly sweep be
   * classified correctly at each call site instead of at construction.
   */
  priority?: DentallyPriority;
}

/**
 * A read refused by the shared budget guard, BEFORE any request was sent.
 *
 * A distinct class because "the platform declined to spend more quota" is not the
 * same fact as "Dentally said no", and a caller that can tell them apart can say
 * so honestly. Every caller in this repo already treats a DentallyError as "this
 * read is unavailable" rather than "there is no data", which is the correct
 * handling for a refusal too — so nothing has to change to be safe, only to be
 * more precise.
 *
 * Status 429 rather than 403: this is our own rate decision, and 429 is what it
 * would be if Dentally had made it.
 */
export class DentallyBudgetExceededError extends DentallyError {
  constructor(
    public priority: DentallyPriority,
    public limit: number,
    path: string,
  ) {
    super(
      429,
      `refusing GET ${path}: the practice's hourly Dentally budget for ${priority} work ` +
        `is spent (ceiling ${limit} of ${DENTALLY_HOURLY_LIMIT}/hour). Abort and retry in the next hour; ` +
        `do NOT loop on this.`,
    );
  }
}

/**
 * IN A `catch`, SEPARATE "WE DECLINED TO SPEND" FROM "DENTALLY SAID NO".
 *
 * Call it as the FIRST statement of a catch that degrades a failed read into an
 * empty/null/"unavailable" value. A real upstream failure falls straight through and
 * the caller's existing degrade runs exactly as before; a BUDGET REFUSAL is re-thrown
 * so it reaches whatever boundary is entitled to decide what to do about it.
 *
 * WHY THE TWO CANNOT SHARE A DEGRADE. Both produce the same shape — an empty scan, a
 * blanked panel — but they are not the same fact, and the difference matters at
 * exactly one place: a CACHE PROMOTE. A read that genuinely failed upstream has
 * nothing better to offer, so caching "unavailable" is honest. A read the platform
 * REFUSED TO MAKE has something better sitting right there — the previously computed
 * value the cache is already serving — and stamping a refusal-shaped blank on top of
 * it destroys good data to record a decision we took about our own quota. Every scan
 * in a multi-site fan-out refuses at once, so what lands in the cache is not a partial
 * picture but a completely blank one, stamped fresh.
 *
 * src/lib/reports/allocation-read.ts made this distinction first (a refusal must not
 * be RETRIED); this is the same distinction at the other end (a refusal must not be
 * CACHED). Both exist because a refusal is a statement about the platform, not about
 * the practice.
 */
export function rethrowIfBudgetRefused(err: unknown): void {
  if (err instanceof DentallyBudgetExceededError) throw err;
}

/**
 * Hard per-request timeout. Without it a hung connection stalls until the 300s
 * function limit, killing an entire unattended sync run. Abort at 15s and
 * surface it as a DentallyError so callers treat it like any other failure.
 */
const REQUEST_TIMEOUT_MS = 15_000;

/** True for an aborted/timed-out fetch (DOMException 'AbortError' or a TimeoutError). */
function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");
}

/** YYYY-MM-DD shifted by whole days (UTC-safe); undefined/unparseable pass through. */
function shiftDay(ymd: string | undefined, days: number): string | undefined {
  if (!ymd) return undefined;
  const t = Date.parse(`${ymd}T00:00:00Z`);
  if (Number.isNaN(t)) return ymd;
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

export interface ListPlansArgs { siteId: string; patientId?: string; updatedAfter?: string; page?: number; perPage?: number; }
/** One patient's charting items. patient_id ONLY: see listTreatmentPlanItems. */
export interface ListTreatmentPlanItemsArgs { patientId: string; page?: number; perPage?: number; }
/**
 * The REPORT read of /v1/treatment_plan_items: practitioner_id + updated_since ONLY.
 * A completely separate entry point from the charting listTreatmentPlanItems (which
 * sends patient_id) so the two calibrations cannot drift into each other.
 * `practitionerId` is OPTIONAL: omit it for the whole-group updated_since slice the
 * report's fallback path uses when the practitioner_id filter regresses (see the
 * method's comment). NO site_id (the item has none), NO patient_id, NO sort_by.
 */
export interface ListTPIByPractitionerArgs { practitionerId?: string; updatedSince?: string; page?: number; perPage?: number; }
/** One patient's treatment APPOINTMENTS — the cards on the plan panel. patient_id
 *  ONLY, for the same reason listTreatmentPlanItemsArgs carries nothing else. */
export interface ListTreatmentAppointmentsArgs { patientId: string; page?: number; perPage?: number; }
/** The practice-wide treatment catalogue / its categories. Neither is patient-scoped. */
export interface ListCatalogueArgs { page?: number; perPage?: number; }
export interface ListPatientsArgs { siteId: string; updatedAfter?: string; query?: string; page?: number; perPage?: number; }
/** Availability is PER PRACTITIONER on live Dentally: /v1/appointments/availability
 *  takes start_time/finish_time (ISO datetimes, NOT dates) + practitioner_ids[] and
 *  each returned row carries its practitioner_id. Calibrated against the live API
 *  2026-07-11 (the earlier site_id/start_date shape 400s with "start_time is missing"). */
export interface AvailabilityArgs {
  practitionerIds: Array<string | number>;
  startTime: string;  // ISO datetime
  finishTime: string; // ISO datetime
  duration?: number;  // minutes
  page?: number;
  perPage?: number;
}

export class DentallyClient {
  private fetchImpl: FetchImpl;
  private userAgent: string;
  /**
   * READ-ONLY BY DEFAULT. `readOnly: false` is the only way to get a client that
   * can write, and it must be passed deliberately.
   *
   * The default used to be the other way round, so nine of the eleven clients in
   * this app were built writable by omission — five of them holding the key named
   * DENTALLY_PROD_READONLY_API_KEY, whose scopes are in fact umbrella
   * create/update/delete over ~51,000 live patients (see assertWritable). Every
   * one of the nine also defaults its base URL to https://api.dentally.co when
   * DENTALLY_BASE_URL is unset, so "I forgot the flag" meant "silent write to the
   * real practice book". Inverted, the same slip is a loud throw in dev instead.
   *
   * Resolved once here rather than read as `opts.readOnly` at each call, so the
   * default cannot be forgotten at one of the write methods.
   */
  private readOnly: boolean;
  constructor(private opts: Opts) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.userAgent = opts.userAgent ?? "Azen-Vitality/0.1 (+https://azen.ai)";
    this.readOnly = opts.readOnly ?? true;
  }

  /**
   * The budget class for the read about to be made. Resolved PER REQUEST, not once
   * in the constructor: a client built by dentallyFromEnv() is handed to a practice
   * manager's dashboard and to the hourly recall sync alike, so freezing the class
   * at construction would classify one of them wrongly. An explicit opts.priority
   * still wins, for the few clients that only ever serve one class.
   */
  private priorityFor(): DentallyPriority {
    return this.opts.priority ?? currentDentallyPriority();
  }

  /**
   * Join base + path by string concatenation (not `new URL(path, base)`), so a
   * base URL that carries its own path prefix is preserved. This lets us point
   * at a local mock server (e.g. http://localhost:3000/api/mock-dentally) as
   * well as the real https://api.sandbox.dentally.co.
   */
  private buildUrl(path: string): URL {
    return new URL(this.opts.baseUrl.replace(/\/+$/, "") + path);
  }

  /**
   * THE READ-ONLY LATCH. Every write method calls this first, so a client built
   * with `readOnly: true` cannot issue one — it throws before the fetch, rather
   * than sending a request and hoping Dentally refuses it.
   *
   * WHY THIS EXISTS AS CODE AND NOT AS A COMMENT. read.ts used to assert that
   * write paths avoid the read key "so a read-only key can never be used to
   * attempt a write against real Dentally". That guarantee was never real, in
   * two ways at once. The key named DENTALLY_PROD_READONLY_API_KEY is not
   * read-only: its x-oauth-scopes header carries the bare umbrella forms
   * (patient, appointment, financials, treatments), each of which Dentally
   * defines as including create, update and delete over ~51,000 live patients.
   * And nothing stopped a caller passing that key to a method that writes.
   *
   * The only thing standing between that key and a destructive call was a
   * User-Agent check on Dentally's side — a 403 reading "Please make sure your
   * request has an acceptable User-Agent header", which this client satisfies
   * on every request. So the credential was, in practice, unguarded from any
   * code path that ran here.
   *
   * Rotating the key to genuinely :read scopes is still owed and is the real
   * fix. This latch is the belt: it makes the property the comment claimed
   * actually hold, on our side, today.
   *
   * Reads this.readOnly, which is `opts.readOnly ?? true` — so a client built
   * without saying anything about writes cannot write.
   */
  private assertWritable(method: string, path: string): void {
    if (this.readOnly) {
      throw new DentallyError(
        0,
        `refusing ${method} ${path}: this DentallyClient is read-only. ` +
          `Writes must go through the write client (see isDentallyWriteEnabled).`,
      );
    }
  }

  /**
   * THE CHOKE POINT. Every read the platform makes goes through this method, so the
   * shared budget guard sits here and nowhere else — a read path added later is
   * guarded by construction rather than by remembering.
   *
   * Writes are deliberately NOT metered. There are five of them, they are gated off
   * in production, they are single requests rather than paged scans, and refusing
   * one mid-booking would leave a patient with a half-made appointment — a far worse
   * failure than the handful of requests they cost. The hard reserve above is what
   * covers them.
   */
  private async get<T>(path: string, query: Record<string, string | number | Array<string | number> | undefined> = {}): Promise<T> {
    const priority = this.priorityFor();
    const decision = await consumeDentallyBudget(priority);
    if (!decision.allowed) {
      // ONE loud line per scope, not one per swallowed read. `scope-refused` means
      // budget.ts already logged the refusal that started it and short-circuited
      // this call without touching the shared counter; repeating it for every row a
      // swallowing sweep walks would bury the line that actually matters.
      if (decision.reason !== "scope-refused") {
        console.warn(
          `[dentally-budget] REFUSED ${priority} GET ${path} — hourly ceiling ${decision.limit} ` +
            `of ${DENTALLY_HOURLY_LIMIT} reached (${decision.reason}).`,
        );
      }
      throw new DentallyBudgetExceededError(priority, decision.limit, path);
    }
    const url = this.buildUrl(path);
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      // Rails-style repeated params (e.g. practitioner_ids[]=1&practitioner_ids[]=2).
      if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, String(item));
      else url.searchParams.set(k, String(v));
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${this.opts.apiKey}`, "User-Agent": this.userAgent, Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      if (isAbortError(e)) throw new DentallyError(0, `request timed out after ${REQUEST_TIMEOUT_MS}ms: GET ${path}`);
      throw e;
    }
    if (!res.ok) throw new DentallyError(res.status, await res.text());
    return (await res.json()) as T;
  }

  /** The practice's sites (read-only). Used to discover real Dentally site IDs. */
  listSites() {
    return this.get<{ sites: unknown[] }>("/v1/sites", { page: 1, per_page: 100 });
  }

  listTreatmentPlans(a: ListPlansArgs) {
    return this.get<{ treatment_plans: unknown[] }>("/v1/treatment_plans", {
      site_id: a.siteId, patient_id: a.patientId, updated_after: a.updatedAfter, page: a.page ?? 1, per_page: a.perPage ?? 100,
    });
  }
  // --- CHARTING (all five READ-ONLY) --------------------------------------
  //
  // These five back the FDI charting screen and its treatment plan panel, which
  // are a READ-ONLY MIRROR of Dentally. NO create/update/delete method is added
  // for any charting resource and none may be: Dentally publishes no create route
  // on treatment_plan_items, treatments, treatment_categories, treatment_plans or
  // treatment_appointments, and a POST 404s on all five. Inventing one is
  // forbidden by their T&Cs, and a client method that looks like a write path is
  // how someone later tries.
  //
  // THE FIFTH (listTreatmentAppointments) IS THE ONE MOST LIKELY TO TEMPT A
  // WRITE, because the panel it feeds renders `+ add appointment`, `Charge`,
  // `Complete treatment plan` and `Submit claim`. Every one of those is rendered
  // DISABLED with its reason stated on screen. `Charge` in particular stays
  // disabled even if a route is later discovered: it moves money, and it does not
  // ship without the owner's separate written sign-off. Do not add a write method
  // here because the API happened to allow one.
  //
  // NOT CALIBRATED AGAINST LIVE. Every other comment on this class records what a
  // real probe returned; these do not, because no probe has run. The field names
  // come from developer.dentally.co (verified 2026-08-01) and nothing more. The
  // `teeth` and `surfaces` wire shapes in particular are unverified, which is why
  // the read layer tolerates arrays, delimited strings and bare numbers and
  // reports anything it cannot place rather than dropping it.

  /**
   * ONE patient's charting items, PAGED.
   *
   * SENDS patient_id AND NOTHING ELSE. No site_id, deliberately:
   *   - patient_id is the documented filter for this endpoint;
   *   - the patient was already resolved (and site-checked) in scope upstream, so
   *     the site adds no safety here;
   *   - listAppointments' own comment records what happens when we send a param
   *     the live API ignores — it reads as though the window were filtered upstream
   *     when it is not, and that is exactly how a miscalibration slipped through
   *     once already.
   * Whether live honours patient_id is itself unverified, so charting-read.ts keeps
   * a client-side patient filter as a safety net the same way the plans read does.
   *
   * MEASURED FILTER TABLE — read-only probes, 2026-08-03, against a base total of
   * 989,336 rows. Recorded here because three of these look like they work and do
   * not:
   *
   *   updated_since=YYYY-MM-DD   WORKS — and it is BARE, not filter[updated_since],
   *                              which is silently ignored (989,336 → 54,953).
   *   patient_id=                WORKS (bare).
   *   treatment_plan_id=         WORKS (bare).
   *   invoice_id=                IGNORED — returns all 989k. There is NO
   *                              server-side way to find the plan items on an
   *                              invoice; the payment-allocation report reads
   *                              invoice_items instead (see getInvoice).
   *   practitioner_id=           HTTP 500.
   *   completed=true             IGNORED (and filter[completed] likewise).
   *   sort_by / sort_direction   IGNORED, AND CORRUPTS ORDERING — sending either
   *                              returned a 2024 row first. Default order is
   *                              already updated_at desc. DO NOT SEND THEM.
   *
   * Population, sampled over 500 recent rows: invoice_id present on 25 (5.0%),
   * `charged: true` mirroring it exactly 1:1; completed on 491 (98.2%), of which
   * only 5.1% are invoiced; practitioner_id and price on 500/500.
   */
  listTreatmentPlanItems(a: ListTreatmentPlanItemsArgs) {
    return this.get<{ treatment_plan_items: unknown[] }>("/v1/treatment_plan_items", {
      patient_id: a.patientId, page: a.page ?? 1, per_page: a.perPage ?? 100,
    });
  }

  /**
   * The SAME endpoint, read the REPORT way: filtered by practitioner_id and
   * updated_since, NOT by patient. This is the scan lever behind Report C
   * (nhs-clinical-activity) — a cheap per-clinician, date-bounded read of the
   * clinical completed/pending signal. Kept SEPARATE from listTreatmentPlanItems
   * on purpose: that call is calibrated for the per-patient charting panel and its
   * callers depend on that shape; recalibrating this path must never touch it.
   *
   * SENDS practitioner_id (when given) + updated_since + paging, AND NOTHING ELSE.
   * No site_id (the item has none — 0/300 sampled — so per-site scoping is done via
   * the practitioner roster upstream), no patient_id, and NO sort_by/sort_direction
   * (they corrupt ordering; the default is already updated_at desc).
   *
   * MEASURED FILTER TABLE — read-only probes, 2026-08-14, base total 998,894:
   *
   *   practitioner_id=          WORKS (bare). A real id (193101) returned total
   *                             32,810 with every sampled row matching; a bogus id
   *                             returned total 0; it COMPOSES with updated_since
   *                             (193101 + updated_since=2026-07-15 -> 2,168, 0.2s).
   *                             THIS DIRECTLY CONTRADICTS the 2026-08-03 client.ts
   *                             note that recorded practitioner_id as HTTP 500 on
   *                             this endpoint. Either Dentally fixed it or 08-03 was
   *                             transient; it is treated as VOLATILE — the report
   *                             re-probes it at run time and falls back to a
   *                             whole-group updated_since slice (this same method
   *                             with practitionerId omitted) filtered to the site
   *                             roster if it 500s again. A cold practitioner_id read
   *                             WITHOUT updated_since was slow (~15s); always send
   *                             updated_since = window.from.
   *   updated_since=YYYY-MM-DD  WORKS (bare) — NOT filter[updated_since]. It is a
   *                             SUPERSET for both halves: completed items have
   *                             updated_at ~ completed_at, pending items have
   *                             updated_at >= created_at >= from. The report then
   *                             windows client-side on completed_at / created_at.
   *   completed=true            IGNORED — filter clinically, client-side.
   *   site_id=                  IGNORED, and there is no site_id on the row anyway.
   *
   * meta.total IS exposed on this endpoint ({ treatment_plan_items, meta:{ total,
   * current_page } }), but the report pages until a short page rather than trusting
   * it, exactly like every other list read here.
   */
  listTreatmentPlanItemsByPractitioner(a: ListTPIByPractitionerArgs) {
    return this.get<{ treatment_plan_items: unknown[]; meta?: { total?: number; current_page?: number | string } }>(
      "/v1/treatment_plan_items",
      {
        practitioner_id: a.practitionerId,
        updated_since: a.updatedSince,
        page: a.page ?? 1,
        per_page: a.perPage ?? 100,
      },
    );
  }

  /**
   * ONE patient's TREATMENT APPOINTMENTS, PAGED. These are the cards on the plan
   * panel: `position` is the card number (position 0 renders as "Appt. 1"),
   * `notes` is the note printed in the card header, and `appointment_id` links the
   * card to a real DIARY appointment.
   *
   * THE DATE, TIME AND PRACTITIONER IN A CARD HEADER ARE NOT ON THIS OBJECT. They
   * live on the diary appointment named by `appointment_id`, which is a separate
   * read (see resolveCardHeaders in charting-read.ts). A reader who assumes
   * otherwise renders a card with no date and no clinician on a booked
   * appointment, which is read as "not yet scheduled" — a false fact about the
   * patient's care, produced by a missing join.
   *
   * SENDS patient_id AND NOTHING ELSE, exactly as listTreatmentPlanItems does and
   * for the reasons spelled out there: patient_id is the documented filter, the
   * patient was already site-checked upstream, and sending a parameter the live
   * API ignores reads as a scoping this call does not perform. Whether live
   * honours patient_id is unverified, so charting-read.ts keeps a client-side
   * patient filter as a safety net.
   */
  listTreatmentAppointments(a: ListTreatmentAppointmentsArgs) {
    return this.get<{ treatment_appointments: unknown[] }>("/v1/treatment_appointments", {
      patient_id: a.patientId, page: a.page ?? 1, per_page: a.perPage ?? 100,
    });
  }

  /** The practice's treatment catalogue (the left-hand list on the chart). Not
   *  patient-scoped and not site-scoped: the catalogue is a practice-wide list. */
  listTreatments(a: ListCatalogueArgs = {}) {
    return this.get<{ treatments: unknown[] }>("/v1/treatments", {
      page: a.page ?? 1, per_page: a.perPage ?? 100,
    });
  }

  /** The catalogue's categories, for the chart's category filter. */
  listTreatmentCategories(a: ListCatalogueArgs = {}) {
    return this.get<{ treatment_categories: unknown[] }>("/v1/treatment_categories", {
      page: a.page ?? 1, per_page: a.perPage ?? 100,
    });
  }

  /**
   * The patient's treatment PLAN ROWS, for the chart's plan tabs.
   *
   * Same endpoint as listTreatmentPlans and a deliberate second entry point rather
   * than a shared one. listTreatmentPlans is live-calibrated for the dashboard's
   * value/outstanding scan and its callers depend on that shape; read.ts's
   * PlanRecord then drops the row's `id` entirely, and a plan tab needs the id, the
   * acceptance date and the completion date. Keeping this call separate means the
   * chart can be recalibrated against live without touching a query the dashboard
   * relies on. site_id IS sent here, unchanged from listTreatmentPlans, because
   * that is the calibrated shape for this path.
   */
  listTreatmentPlansById(a: { siteId: string; patientId: string; page?: number; perPage?: number }) {
    return this.get<{ treatment_plans: unknown[] }>("/v1/treatment_plans", {
      site_id: a.siteId, patient_id: a.patientId, page: a.page ?? 1, per_page: a.perPage ?? 100,
    });
  }

  getPatient(id: string) { return this.get<{ patient: unknown }>(`/v1/patients/${id}`); }

  /** Exact patient count for a site straight from the index metadata: real Dentally
   *  returns `meta.total` on /v1/patients, so one 1-row page answers "how many
   *  patients does this site have" without scanning the book. Returns null when the
   *  source exposes no total (the local mock). */
  async countPatients(siteId: string): Promise<number | null> {
    const res = await this.get<{ patients: unknown[]; meta?: { total?: number } }>("/v1/patients", {
      site_id: siteId, page: 1, per_page: 1,
    });
    const total = res.meta?.total;
    return typeof total === "number" && Number.isFinite(total) ? total : null;
  }

  /** Register a new patient (onboarding). */
  async createPatient(payload: Record<string, unknown>) {
    this.assertWritable("POST", "/v1/patients");
    const url = this.buildUrl("/v1/patients");
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`, "User-Agent": this.userAgent,
          "Content-Type": "application/json", Accept: "application/json",
        },
        body: JSON.stringify({ patient: payload }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      if (isAbortError(e)) throw new DentallyError(0, `request timed out after ${REQUEST_TIMEOUT_MS}ms: POST /v1/patients`);
      throw e;
    }
    if (!res.ok) throw new DentallyError(res.status, await res.text());
    return (await res.json()) as { patient: { id: string } };
  }

  /**
   * Edit an existing patient (PUT /v1/patients/:id). Real Dentally documents an
   * `active` boolean on the patient and its "Edit a patient" endpoint accepts `active`
   * as an optional field in the wrapped `patient` body (partial update) - deleting a
   * patient merely "sets the patient's active flag to false and can be undone by simply
   * setting the active flag back to true". So active<->inactive is a genuine upstream
   * write; there is no do-not-contact field, which the caller keeps platform-only.
   *
   * Mirrors updateAppointment exactly: wraps the fields in { patient }, tolerates a 204
   * / empty body so a completed edit is never misreported as a failure, and surfaces a
   * non-2xx as a DentallyError. Only reached through the gated write client
   * (dentallyAgentClient), so it can never touch real Dentally until writes are enabled.
   */
  async updatePatient(id: string, fields: Record<string, unknown>) {
    this.assertWritable("PUT", "/v1/patients/:id");
    const url = this.buildUrl(`/v1/patients/${id}`);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`, "User-Agent": this.userAgent,
          "Content-Type": "application/json", Accept: "application/json",
        },
        body: JSON.stringify({ patient: fields }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      if (isAbortError(e)) throw new DentallyError(0, `request timed out after ${REQUEST_TIMEOUT_MS}ms: PUT /v1/patients/${id}`);
      throw e;
    }
    if (!res.ok) throw new DentallyError(res.status, await res.text());
    if (res.status === 204) return { patient: { id } };
    const text = await res.text();
    return text
      ? (JSON.parse(text) as { patient: { id: string; active?: boolean } })
      : { patient: { id } };
  }

  /**
   * Find patients by mobile phone number. Used to recognise an inbound SMS caller
   * and to reuse an existing patient on the public booking page. CALIBRATED live
   * 2026-07-11: Dentally IGNORES a `mobile_phone=` filter (returns an unfiltered
   * page), but its `query=` name/contact search matches a phone number exactly in
   * any common format. Callers must still exact-match the returned rows' own
   * mobile numbers (identify.ts does; never trust list[0]).
   */
  findPatientsByPhone(phone: string) {
    return this.get<{ patients: unknown[] }>("/v1/patients", { query: phone });
  }
  getAccountOutstanding(patientId: string) {
    return this.get<{ payment_plans: unknown[] }>("/v1/payment_plans", { patient_id: patientId });
  }

  listPatients(a: ListPatientsArgs) {
    // `query` is Dentally's name/contact search param. Existing callers omit it, so
    // it stays undefined and the request is unchanged (get() drops undefined params).
    return this.get<{ patients: unknown[] }>("/v1/patients", {
      site_id: a.siteId, updated_after: a.updatedAfter, query: a.query, page: a.page ?? 1, per_page: a.perPage ?? 100,
    });
  }
  getPatientAppointments(patientId: string, page = 1, perPage = 100, includeCancelled = false) {
    // Dentally excludes Cancelled / Did-not-attend rows unless cancelled=true.
    // The no-show risk history opts IN (it needs past DNAs to score risk); recall
    // keeps the default OUT, so a cancelled future booking never masquerades as
    // futureBookingExists and silently suppress a due recall.
    return this.get<{ appointments: unknown[] }>("/v1/appointments", {
      patient_id: patientId, page, per_page: perPage,
      cancelled: includeCancelled ? "true" : undefined,
    });
  }
  listAppointments(a: { siteId: string; fromDate?: string; toDate?: string; page?: number; perPage?: number }) {
    // Paginate: the real Dentally API caps a page at ~50-100 rows, so a single
    // unpaged call silently drops every appointment past the first page (a large
    // practice's busiest days would go undefended). Callers loop pages until a
    // short page. Default per_page matches the other list endpoints (100).
    //
    // Date filtering (calibrated 2026-07-05 against the live API docs): real
    // Dentally filters with `on` / `after` / `before` — NOT start_date /
    // finish_date, which it silently IGNORES. An ignored filter meant paging the
    // practice's entire appointment book (the no-show sync burned its whole
    // per-run cap on ancient history and produced zero targets). `on` is exact
    // for a single day; for a range the docs leave after/before edge semantics
    // unstated, so pad each edge by a day and let callers' precise windows trim.
    // cancelled=true includes Cancelled / Did-not-attend rows (excluded by
    // default), which no-show reconciliation and the daily-brief gap count need.
    const single = a.fromDate !== undefined && a.fromDate === a.toDate;
    return this.get<{ appointments: unknown[] }>("/v1/appointments", {
      site_id: a.siteId,
      on: single ? a.fromDate : undefined,
      after: single ? undefined : shiftDay(a.fromDate, -1),
      before: single ? undefined : shiftDay(a.toDate, 1),
      cancelled: "true",
      page: a.page ?? 1, per_page: a.perPage ?? 100,
    });
  }
  /**
   * ONE patient's invoices, PAGED.
   *
   * It used to send patient_id alone. Dentally caps a page at ~100 rows, so a
   * long-standing patient's invoice history stopped at the first page with no
   * marker, and Balance, Lifetime spend, Total invoiced and Total paid were all
   * reduced over the truncated array and printed as confident fact. A patient with
   * 40 invoices whose 3 unpaid ones fell past the first page read "Balance £0.00" on
   * the record while the dashboard debtors panel, which pages the index properly,
   * listed them owing hundreds.
   */
  getPatientInvoices(patientId: string, page = 1, perPage = 100) {
    return this.get<{ invoices: unknown[] }>("/v1/invoices", {
      patient_id: patientId, page, per_page: perPage,
    });
  }
  /**
   * List invoices for the outstanding-balance scan. With `patientId` it is one
   * patient's invoices; without, it is the practice index (paged), which real
   * Dentally may return group-wide (like treatment_plans) regardless of site_id.
   * The balance is derived from each invoice's gross/total vs paid.
   */
  listInvoices(a: { patientId?: string; siteId?: string; page?: number; perPage?: number; paid?: boolean }) {
    return this.get<{ invoices: unknown[] }>("/v1/invoices", {
      patient_id: a.patientId, site_id: a.siteId, page: a.page ?? 1, per_page: a.perPage ?? 100,
      // Filter to UNPAID invoices server-side when asked. The invoices index is dominated
      // by settled rows; without this filter the bounded page scan spends its budget on
      // paid invoices and understates the outstanding total. Sent as a string; a source
      // that ignores the param returns the same rows we then filter by balance anyway,
      // so this can only tighten the scan, never regress it.
      paid: a.paid === undefined ? undefined : String(a.paid),
    });
  }
  /**
   * ONE invoice, WITH ITS LINES. The only place Dentally records which clinician
   * earned which money, and therefore the spine of the payment-allocation report.
   *
   * PROVENANCE — read-only GETs, 2026-08-03, 235 invoices fetched by walking 258
   * payment-explanation legs on the live 51k-patient account:
   *
   *   - envelope key is `invoice` (singular); the lines are `invoice_items[]`.
   *   - `invoice_items` EXISTS ONLY ON THIS DETAIL ROUTE. The index
   *     (GET /v1/invoices, 33,662 rows) carries no lines at all, and
   *     `include=invoice_items` on the index is IGNORED — so there is no way to
   *     read attribution in bulk; it is one GET per invoice.
   *   - the invoice HEADER carries no practitioner_id. Attribution exists only on
   *     the lines.
   *   - item keys: created_at, id, invoice_id, item_price, name, nhs_charge,
   *     practitioner_id, quantity, sundry_id, total_price, treatment_plan_id,
   *     treatment_plan_item_id, updated_at, user_id.
   *   - every item carried practitioner_id on 256/256 sampled legs, and
   *     Σ invoice_items.total_price == invoice.amount on 256/256.
   *   - nhs_amount was NULL on 256/256 and item nhs_charge 0 on 728/728: the
   *     NHS/private split is NOT readable this way and must not be claimed.
   *   - 0/256 invoices carried a sundry line — an untested path.
   *   - ~0.4% of these GETs returned a non-200 transiently (1 of 235); the retry
   *     succeeded, so callers retry ONCE and then report the invoice unreadable
   *     rather than dropping its money.
   *   - rate limit observed: x-ratelimit-limit 3600/hour.
   *
   * Returns the raw envelope like every other read here; invoiceFromEnvelope in
   * ./invoice-shape unwraps it and REFUSES a shape it does not recognise rather
   * than degrading to an empty line list.
   */
  getInvoice(id: string) {
    return this.get<Record<string, unknown>>(`/v1/invoices/${id}`);
  }
  /**
   * ONE patient's clinical notes, PAGED. Same defect as getPatientInvoices had, and
   * this is the ONE stream on the record where a dropped row can be an allergy or a
   * medication warning: a patient of fifteen years with 200 notes rendered the most
   * recent page as if it were the whole history.
   *
   * THE PATH IS `/v1/notes`, NOT `/v1/patient_notes`. The latter was invented here
   * and 404s on real Dentally, so the Clinical notes tab failed on every live patient
   * open while the mock served the invented path and kept dev green. `/v1/notes` is
   * undocumented but real: a read-only GET on 2026-08-03 returned 200 and
   * `{"notes":[],"meta":{...}}`. The envelope is returned RAW, exactly like every
   * other read here; notesFromEnvelope in ./notes-shape unwraps it and refuses a
   * shape it does not recognise instead of falling back to an empty page.
   */
  getPatientNotes(patientId: string, page = 1, perPage = 100) {
    return this.get<Record<string, unknown>>("/v1/notes", {
      patient_id: patientId, page, per_page: perPage,
    });
  }

  /**
   * Payments, for the dashboard takings strip. CALIBRATED against live Dentally on 2026-07-30 by the project owner's own read-only probe, NOT by the code below.
   *
   * Dentally IGNORES every date filter on this endpoint: filter[from], from and
   * dated_on_from all come back with the whole set (40,243 rows). It DOES honour
   * site_id (which drops that to 7,784). Results are returned NEWEST FIRST.
   *
   * So no date parameter is sent at all. Sending one would suggest to a reader
   * that the window is filtered upstream when it is not, which is precisely the
   * mistake that cost the no-show sync a whole run's budget. A period total is
   * built by paging from page 1 backwards through time and stopping once
   * `dated_on` passes the boundary. That is cheap for today and yesterday; the
   * 7, 30 and 90 day cells are served from the stored daily rollup instead.
   *
   * Field notes: `amount` is a STRING ("27.9"), `dated_on` is a bare YYYY-MM-DD
   * with no time zone, and `deleted` is a boolean that must be excluded from
   * totals. The `status` vocabulary is not verified; do not branch on it.
   *
   * Two further facts, from a read-only probe on 2026-08-03, recorded because the
   * repo previously claimed the opposite. `patient_id` IS honoured: ?patient_id=
   * returned exactly that patient's payments (meta.total 1), so a per-patient
   * payments read is possible. And every row carries `explanations[]` — each entry
   * holding invoice_id, invoice_reference, amount, payment_id and user_id —
   * alongside `fully_explained` and `amount_unexplained`, so the payment→invoice
   * allocation link is on this endpoint (30 of 50 sampled rows had a non-empty
   * array). Neither is read by any caller yet.
   */
  listPayments(a: { siteId?: string; page?: number; perPage?: number }) {
    return this.get<{ payments: unknown[] }>("/v1/payments", {
      site_id: a.siteId, page: a.page ?? 1, per_page: a.perPage ?? 100,
    });
  }

  /**
   * NHS claims, for the dashboard UDA block.
   *
   * PROVENANCE: the field names, types and row count below come from a READ-ONLY
   * probe of live Dentally run by the project owner on 2026-07-30, not from this
   * code and not from any automated run. `expected_uda` and `awarded_uda` are
   * STRINGS ("1.56"), `submitted_date` is a bare YYYY-MM-DD, and 52,875 rows
   * existed at that time. Re-probe before trusting these if the shape ever looks
   * wrong: nothing in this repo re-verifies them.
   *
   * No date parameter is sent, on the same reasoning as listPayments: filtering
   * is confirmed ignored on /v1/payments and was NOT confirmed working here, so
   * assuming it works would be assuming the more convenient answer. Callers page
   * from newest backwards and stop at their boundary. Only "submitted" is a
   * confirmed claim_status value, so an unfamiliar status must count toward
   * neither the completed nor the invalid UDA total.
   */
  listNhsClaims(a: { siteId?: string; page?: number; perPage?: number }) {
    return this.get<{ nhs_claims: unknown[] }>("/v1/nhs_claims", {
      site_id: a.siteId, page: a.page ?? 1, per_page: a.perPage ?? 100,
    });
  }

  /**
   * Availability windows per practitioner.
   *
   * page and per_page are SENT, like every other list read on this client. It is
   * not known whether this endpoint pages, and that is exactly why: if it does,
   * a caller taking the first response as the whole answer would silently lose
   * every window past the cut, and the diary renders a missing window as "this
   * clinician is not working" - a positive claim that the practice is shut,
   * produced by a partial read. Sending the parameters is harmless if they are
   * ignored and correct if they are not.
   */
  getAvailability(a: AvailabilityArgs) {
    return this.get<{ availability: unknown[] }>("/v1/appointments/availability", {
      start_time: a.startTime,
      finish_time: a.finishTime,
      duration: a.duration,
      page: a.page ?? 1,
      per_page: a.perPage ?? 100,
      "practitioner_ids[]": a.practitionerIds,
    });
  }

  /**
   * A site's practitioners (live shape: {id, active, site_id, user:{...}}). Used to
   * drive availability, which is queried per practitioner id, and to put a NAME
   * against the practitioner_id every treatment_plan_item carries.
   *
   * `page` IS NOW SENT, and defaults to 1 so every existing caller keeps exactly
   * the request it made before. It exists because the plan panel's read walks this
   * endpoint with the same pageAll() every other list read on that path uses: a
   * caller that took the first response as the whole answer would, at a practice
   * with more than a page of practitioners, silently fail to name the clinician on
   * a clinical record and render an empty initials column instead. Sending the
   * parameter is harmless if Dentally ignores it and correct if it does not.
   */
  listPractitioners(siteId: string, a: { page?: number; perPage?: number } = {}) {
    return this.get<{ practitioners: unknown[] }>("/v1/practitioners", {
      site_id: siteId, page: a.page ?? 1, per_page: a.perPage ?? 100,
    });
  }

  async createAppointment(payload: Record<string, unknown>) {
    this.assertWritable("POST", "/v1/appointments");
    const url = this.buildUrl("/v1/appointments");
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`, "User-Agent": this.userAgent,
          "Content-Type": "application/json", Accept: "application/json",
        },
        body: JSON.stringify({ appointment: payload }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      if (isAbortError(e)) throw new DentallyError(0, `request timed out after ${REQUEST_TIMEOUT_MS}ms: POST /v1/appointments`);
      throw e;
    }
    if (!res.ok) throw new DentallyError(res.status, await res.text());
    return (await res.json()) as { appointment: { id: string } };
  }

  /** Edit an existing appointment, e.g. move it to a new start_time (reschedule). */
  async updateAppointment(id: string, payload: Record<string, unknown>) {
    this.assertWritable("PUT", "/v1/appointments/:id");
    const url = this.buildUrl(`/v1/appointments/${id}`);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`, "User-Agent": this.userAgent,
          "Content-Type": "application/json", Accept: "application/json",
        },
        body: JSON.stringify({ appointment: payload }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      if (isAbortError(e)) throw new DentallyError(0, `request timed out after ${REQUEST_TIMEOUT_MS}ms: PUT /v1/appointments/${id}`);
      throw e;
    }
    if (!res.ok) throw new DentallyError(res.status, await res.text());
    // A successful PUT may come back as 204 No Content or with an empty body; parsing
    // that as JSON would throw and misreport a completed reschedule as a failure.
    if (res.status === 204) return { appointment: { id } };
    const text = await res.text();
    return text
      ? (JSON.parse(text) as { appointment: { id: string; start_time?: string; state?: string } })
      : { appointment: { id } };
  }

  /** Cancel an existing appointment (sets its state to cancelled). */
  async cancelAppointment(id: string) {
    this.assertWritable("DELETE", "/v1/appointments/:id");
    const url = this.buildUrl(`/v1/appointments/${id}`);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${this.opts.apiKey}`, "User-Agent": this.userAgent, Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      if (isAbortError(e)) throw new DentallyError(0, `request timed out after ${REQUEST_TIMEOUT_MS}ms: DELETE /v1/appointments/${id}`);
      throw e;
    }
    if (!res.ok) throw new DentallyError(res.status, await res.text());
    // DELETE typically returns 204 No Content (or an empty body) on success; parsing
    // that as JSON would throw and misreport a completed cancellation as a failure.
    if (res.status === 204) return { appointment: { id, state: "cancelled" } };
    const text = await res.text();
    return text
      ? (JSON.parse(text) as { appointment: { id: string; state?: string } })
      : { appointment: { id, state: "cancelled" } };
  }
}
