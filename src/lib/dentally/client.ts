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
   * Set on the client that carries the READ key — see assertWritable below for
   * why a comment was not enough.
   */
  readOnly?: boolean;
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
  constructor(private opts: Opts) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.userAgent = opts.userAgent ?? "Azen-Vitality/0.1 (+https://azen.ai)";
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
   */
  private assertWritable(method: string, path: string): void {
    if (this.opts.readOnly) {
      throw new DentallyError(
        0,
        `refusing ${method} ${path}: this DentallyClient is read-only. ` +
          `Writes must go through the write client (see isDentallyWriteEnabled).`,
      );
    }
  }

  private async get<T>(path: string, query: Record<string, string | number | Array<string | number> | undefined> = {}): Promise<T> {
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
   */
  listTreatmentPlanItems(a: ListTreatmentPlanItemsArgs) {
    return this.get<{ treatment_plan_items: unknown[] }>("/v1/treatment_plan_items", {
      patient_id: a.patientId, page: a.page ?? 1, per_page: a.perPage ?? 100,
    });
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
   * ONE patient's clinical notes, PAGED. Same defect as getPatientInvoices had, and
   * this is the ONE stream on the record where a dropped row can be an allergy or a
   * medication warning: a patient of fifteen years with 200 notes rendered the most
   * recent page as if it were the whole history.
   */
  getPatientNotes(patientId: string, page = 1, perPage = 100) {
    return this.get<{ patient_notes: unknown[] }>("/v1/patient_notes", {
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
