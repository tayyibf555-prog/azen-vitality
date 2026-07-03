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

export interface ListPlansArgs { siteId: string; updatedAfter?: string; page?: number; perPage?: number; }
export interface ListPatientsArgs { siteId: string; updatedAfter?: string; page?: number; perPage?: number; }
export interface AvailabilityArgs { siteId: string; fromDate?: string; toDate?: string; duration?: number; }

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

  private async get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = this.buildUrl(path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
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

  listTreatmentPlans(a: ListPlansArgs) {
    return this.get<{ treatment_plans: unknown[] }>("/v1/treatment_plans", {
      site_id: a.siteId, updated_after: a.updatedAfter, page: a.page ?? 1, per_page: a.perPage ?? 100,
    });
  }
  getPatient(id: string) { return this.get<{ patient: unknown }>(`/v1/patients/${id}`); }

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
   * Find patients by mobile phone number. Used to recognise an inbound SMS from
   * any number, not just reactivation targets. The exact filter param is to be
   * calibrated against the live sandbox; the local mock accepts `mobile_phone`.
   */
  findPatientsByPhone(phone: string) {
    return this.get<{ patients: unknown[] }>("/v1/patients", { mobile_phone: phone });
  }
  getAccountOutstanding(patientId: string) {
    return this.get<{ payment_plans: unknown[] }>("/v1/payment_plans", { patient_id: patientId });
  }

  listPatients(a: ListPatientsArgs) {
    return this.get<{ patients: unknown[] }>("/v1/patients", {
      site_id: a.siteId, updated_after: a.updatedAfter, page: a.page ?? 1, per_page: a.perPage ?? 100,
    });
  }
  getPatientAppointments(patientId: string) {
    return this.get<{ appointments: unknown[] }>("/v1/appointments", { patient_id: patientId });
  }
  listAppointments(a: { siteId: string; fromDate?: string; toDate?: string; page?: number; perPage?: number }) {
    // Paginate: the real Dentally API caps a page at ~50-100 rows, so a single
    // unpaged call silently drops every appointment past the first page (a large
    // practice's busiest days would go undefended). Callers loop pages until a
    // short page. Default per_page matches the other list endpoints (100).
    return this.get<{ appointments: unknown[] }>("/v1/appointments", {
      site_id: a.siteId, start_date: a.fromDate, finish_date: a.toDate,
      page: a.page ?? 1, per_page: a.perPage ?? 100,
    });
  }
  getPatientInvoices(patientId: string) {
    return this.get<{ invoices: unknown[] }>("/v1/invoices", { patient_id: patientId });
  }
  getPatientNotes(patientId: string) {
    return this.get<{ patient_notes: unknown[] }>("/v1/patient_notes", { patient_id: patientId });
  }

  getAvailability(a: AvailabilityArgs) {
    return this.get<{ availability: unknown[] }>("/v1/appointments/availability", {
      site_id: a.siteId, start_date: a.fromDate, finish_date: a.toDate, duration: a.duration,
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
