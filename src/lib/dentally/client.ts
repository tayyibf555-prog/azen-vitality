type FetchImpl = typeof fetch;

export class DentallyError extends Error {
  constructor(public status: number, message: string) {
    super(`Dentally ${status}: ${message}`);
  }
}

interface Opts { apiKey: string; baseUrl: string; fetchImpl?: FetchImpl; userAgent?: string; }

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
    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${this.opts.apiKey}`, "User-Agent": this.userAgent, Accept: "application/json" },
    });
    if (!res.ok) throw new DentallyError(res.status, await res.text());
    return (await res.json()) as T;
  }

  listTreatmentPlans(a: ListPlansArgs) {
    return this.get<{ treatment_plans: unknown[] }>("/v1/treatment_plans", {
      site_id: a.siteId, updated_after: a.updatedAfter, page: a.page ?? 1, per_page: a.perPage ?? 100,
    });
  }
  getPatient(id: string) { return this.get<{ patient: unknown }>(`/v1/patients/${id}`); }

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
  listAppointments(a: { siteId: string; fromDate?: string; toDate?: string }) {
    return this.get<{ appointments: unknown[] }>("/v1/appointments", {
      site_id: a.siteId, start_date: a.fromDate, finish_date: a.toDate,
    });
  }
  getPatientInvoices(patientId: string) {
    return this.get<{ invoices: unknown[] }>("/v1/invoices", { patient_id: patientId });
  }

  getAvailability(a: AvailabilityArgs) {
    return this.get<{ availability: unknown[] }>("/v1/appointments/availability", {
      site_id: a.siteId, start_date: a.fromDate, finish_date: a.toDate, duration: a.duration,
    });
  }

  async createAppointment(payload: Record<string, unknown>) {
    const url = this.buildUrl("/v1/appointments");
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`, "User-Agent": this.userAgent,
        "Content-Type": "application/json", Accept: "application/json",
      },
      body: JSON.stringify({ appointment: payload }),
    });
    if (!res.ok) throw new DentallyError(res.status, await res.text());
    return (await res.json()) as { appointment: { id: string } };
  }
}
