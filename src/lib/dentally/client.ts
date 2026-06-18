type FetchImpl = typeof fetch;

export class DentallyError extends Error {
  constructor(public status: number, message: string) {
    super(`Dentally ${status}: ${message}`);
  }
}

interface Opts { apiKey: string; baseUrl: string; fetchImpl?: FetchImpl; userAgent?: string; }

export interface ListPlansArgs { siteId: string; updatedAfter?: string; page?: number; perPage?: number; }

export class DentallyClient {
  private fetchImpl: FetchImpl;
  private userAgent: string;
  constructor(private opts: Opts) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.userAgent = opts.userAgent ?? "Azen-Vitality/0.1 (+https://azen.ai)";
  }

  private async get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(path, this.opts.baseUrl);
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
  getAccountOutstanding(patientId: string) {
    return this.get<{ payment_plans: unknown[] }>("/v1/payment_plans", { patient_id: patientId });
  }

  async createAppointment(payload: Record<string, unknown>) {
    const url = new URL("/v1/appointments", this.opts.baseUrl);
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
