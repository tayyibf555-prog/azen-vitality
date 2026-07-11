type FetchImpl = typeof fetch;

export class DentallyError extends Error {
  constructor(public status: number, message: string) {
    super(`Dentally ${status}: ${message}`);
  }
}

interface Opts { apiKey: string; baseUrl: string; fetchImpl?: FetchImpl; userAgent?: string; }

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
  getPatientInvoices(patientId: string) {
    return this.get<{ invoices: unknown[] }>("/v1/invoices", { patient_id: patientId });
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
  getPatientNotes(patientId: string) {
    return this.get<{ patient_notes: unknown[] }>("/v1/patient_notes", { patient_id: patientId });
  }

  getAvailability(a: AvailabilityArgs) {
    return this.get<{ availability: unknown[] }>("/v1/appointments/availability", {
      start_time: a.startTime,
      finish_time: a.finishTime,
      duration: a.duration,
      "practitioner_ids[]": a.practitionerIds,
    });
  }

  /** A site's practitioners (live shape: {id, active, site_id, user:{...}}). Used to
   *  drive availability, which is queried per practitioner id. */
  listPractitioners(siteId: string) {
    return this.get<{ practitioners: unknown[] }>("/v1/practitioners", {
      site_id: siteId, per_page: 100,
    });
  }

  async createAppointment(payload: Record<string, unknown>) {
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
