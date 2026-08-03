import { describe, it, expect, vi } from "vitest";
import { DentallyClient } from "./client";

function mockFetch(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok, status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

describe("DentallyClient", () => {
  it("sends auth + User-Agent headers to the configured base URL", async () => {
    const fetchMock = mockFetch({ treatment_plans: [] });
    const c = new DentallyClient({ apiKey: "k", baseUrl: "https://api.sandbox.dentally.co", fetchImpl: fetchMock });
    await c.listTreatmentPlans({ siteId: "site-cc" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("https://api.sandbox.dentally.co");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer k");
    expect((init.headers as Record<string, string>)["User-Agent"]).toBeTruthy();
  });

  it("throws a DentallyError on non-2xx", async () => {
    const fetchMock = mockFetch({ error: "nope" }, false, 401);
    const c = new DentallyClient({ apiKey: "k", baseUrl: "https://x", fetchImpl: fetchMock });
    await expect(c.listTreatmentPlans({ siteId: "s" })).rejects.toThrow(/401/);
  });

  // Calibrated against the real Dentally docs (2026-07-05): the appointment list
  // filters with on/after/before + cancelled. start_date/finish_date are silently
  // IGNORED by the real API — these tests pin the calibration so a regression to
  // the invented params fails loudly instead of paging the whole book again.
  describe("listAppointments date params", () => {
    it("sends on + cancelled=true for a single-day window, never start_date", async () => {
      const fetchMock = mockFetch({ appointments: [] });
      const c = new DentallyClient({ apiKey: "k", baseUrl: "https://x", fetchImpl: fetchMock });
      await c.listAppointments({ siteId: "s1", fromDate: "2026-07-05", toDate: "2026-07-05" });
      const url = new URL(String(fetchMock.mock.calls[0][0]));
      expect(url.searchParams.get("on")).toBe("2026-07-05");
      expect(url.searchParams.get("cancelled")).toBe("true");
      expect(url.searchParams.get("after")).toBeNull();
      expect(url.searchParams.get("before")).toBeNull();
      expect(url.searchParams.get("start_date")).toBeNull();
      expect(url.searchParams.get("finish_date")).toBeNull();
    });

    it("pads a range by a day on each edge via after/before", async () => {
      const fetchMock = mockFetch({ appointments: [] });
      const c = new DentallyClient({ apiKey: "k", baseUrl: "https://x", fetchImpl: fetchMock });
      await c.listAppointments({ siteId: "s1", fromDate: "2026-07-05", toDate: "2026-07-19" });
      const url = new URL(String(fetchMock.mock.calls[0][0]));
      expect(url.searchParams.get("after")).toBe("2026-07-04");
      expect(url.searchParams.get("before")).toBe("2026-07-20");
      expect(url.searchParams.get("on")).toBeNull();
      expect(url.searchParams.get("cancelled")).toBe("true");
    });

    it("pads across month boundaries correctly", async () => {
      const fetchMock = mockFetch({ appointments: [] });
      const c = new DentallyClient({ apiKey: "k", baseUrl: "https://x", fetchImpl: fetchMock });
      await c.listAppointments({ siteId: "s1", fromDate: "2026-08-01", toDate: "2026-08-31" });
      const url = new URL(String(fetchMock.mock.calls[0][0]));
      expect(url.searchParams.get("after")).toBe("2026-07-31");
      expect(url.searchParams.get("before")).toBe("2026-09-01");
    });
  });

  // The four charting reads. These are NOT live-calibrated (no probe has run), so
  // what is pinned here is the DECISION about each query, not a measured response:
  // if a later contributor "tidies" one of them the intent is stated in the failure.
  describe("charting reads", () => {
    it("listTreatmentPlanItems sends patient_id and deliberately NO site_id", async () => {
      const fetchMock = mockFetch({ treatment_plan_items: [] });
      const c = new DentallyClient({ apiKey: "k", baseUrl: "https://x", fetchImpl: fetchMock });
      await c.listTreatmentPlanItems({ patientId: "pat-001", page: 2 });
      const url = new URL(String(fetchMock.mock.calls[0][0]));
      expect(url.pathname).toBe("/v1/treatment_plan_items");
      expect(url.searchParams.get("patient_id")).toBe("pat-001");
      expect(url.searchParams.get("page")).toBe("2");
      expect(url.searchParams.get("per_page")).toBe("100");
      // Pinned so nobody adds it back "for symmetry" with listTreatmentPlans: the
      // patient is already site-checked upstream, and a param live may ignore reads
      // as though the call were scoped when it is not.
      expect(url.searchParams.get("site_id")).toBeNull();
    });

    it("listTreatments hits the catalogue index with paging", async () => {
      const fetchMock = mockFetch({ treatments: [] });
      const c = new DentallyClient({ apiKey: "k", baseUrl: "https://x", fetchImpl: fetchMock });
      await c.listTreatments({ page: 3, perPage: 50 });
      const url = new URL(String(fetchMock.mock.calls[0][0]));
      expect(url.pathname).toBe("/v1/treatments");
      expect(url.searchParams.get("page")).toBe("3");
      expect(url.searchParams.get("per_page")).toBe("50");
    });

    it("listTreatmentCategories hits the categories index", async () => {
      const fetchMock = mockFetch({ treatment_categories: [] });
      const c = new DentallyClient({ apiKey: "k", baseUrl: "https://x", fetchImpl: fetchMock });
      await c.listTreatmentCategories();
      const url = new URL(String(fetchMock.mock.calls[0][0]));
      expect(url.pathname).toBe("/v1/treatment_categories");
      expect(url.searchParams.get("page")).toBe("1");
    });

    it("listTreatmentPlansById sends site_id AND patient_id (the calibrated plans shape)", async () => {
      const fetchMock = mockFetch({ treatment_plans: [] });
      const c = new DentallyClient({ apiKey: "k", baseUrl: "https://x", fetchImpl: fetchMock });
      await c.listTreatmentPlansById({ siteId: "site-cc", patientId: "pat-001" });
      const url = new URL(String(fetchMock.mock.calls[0][0]));
      expect(url.pathname).toBe("/v1/treatment_plans");
      expect(url.searchParams.get("site_id")).toBe("site-cc");
      expect(url.searchParams.get("patient_id")).toBe("pat-001");
    });

    // THE CLINICAL-SAFETY ASSERTION OF THIS FILE. Dentally publishes no create route
    // on any charting resource (POST 404s on all five) and their T&Cs forbid a custom
    // bridge, so the chart is a read-only mirror. A charting write method on this
    // class is the first step of building one; this fails the moment one appears.
    it("exposes no create/update/delete method for any treatment resource", () => {
      const names = Object.getOwnPropertyNames(DentallyClient.prototype);
      const writes = names.filter(
        (n) => /treatment/i.test(n) && /^(create|update|delete|post|put|patch|save|upsert)/i.test(n),
      );
      expect(writes).toEqual([]);
    });
  });

  describe("getPatientAppointments cancelled flag", () => {
    it("omits cancelled by default (recall must not see cancelled future bookings)", async () => {
      const fetchMock = mockFetch({ appointments: [] });
      const c = new DentallyClient({ apiKey: "k", baseUrl: "https://x", fetchImpl: fetchMock });
      await c.getPatientAppointments("p1");
      const url = new URL(String(fetchMock.mock.calls[0][0]));
      expect(url.searchParams.get("cancelled")).toBeNull();
    });

    it("sends cancelled=true when history needs DNAs (no-show risk)", async () => {
      const fetchMock = mockFetch({ appointments: [] });
      const c = new DentallyClient({ apiKey: "k", baseUrl: "https://x", fetchImpl: fetchMock });
      await c.getPatientAppointments("p1", 1, 100, true);
      const url = new URL(String(fetchMock.mock.calls[0][0]));
      expect(url.searchParams.get("cancelled")).toBe("true");
    });
  });

  // ---------------------------------------------------------------------------
  // THE READ-ONLY LATCH.
  //
  // The credential named DENTALLY_PROD_READONLY_API_KEY is not read-only: its
  // x-oauth-scopes header carries Dentally's bare umbrella scopes (patient,
  // appointment, financials, treatments), each defined by their own docs as
  // including create, update and delete over ~51,000 live patient records. The
  // only thing that ever stopped a destructive call was a User-Agent check on
  // Dentally's side, which this client satisfies on every request.
  //
  // These tests exist so the separation between the read client and the write
  // client is a property of the code rather than a convention. Each asserts the
  // throw happens BEFORE any network call - fetch must be untouched, because a
  // write that leaves the process has already lost.
  // ---------------------------------------------------------------------------
  describe("readOnly", () => {
    const writes: Array<[string, (c: DentallyClient) => Promise<unknown>]> = [
      ["createPatient", (c) => c.createPatient({ first_name: "x" })],
      ["updatePatient", (c) => c.updatePatient("p1", { first_name: "x" })],
      ["createAppointment", (c) => c.createAppointment({ patient_id: "p1" })],
      ["updateAppointment", (c) => c.updateAppointment("a1", { start_time: "x" })],
      ["cancelAppointment", (c) => c.cancelAppointment("a1")],
    ];

    for (const [name, call] of writes) {
      it(`refuses ${name} without touching the network`, async () => {
        const fetchMock = mockFetch({});
        const c = new DentallyClient({ apiKey: "k", baseUrl: "https://x", fetchImpl: fetchMock, readOnly: true });
        await expect(call(c)).rejects.toThrow(/read-only/i);
        expect(fetchMock).not.toHaveBeenCalled();
      });
    }

    it("still allows reads", async () => {
      const fetchMock = mockFetch({ sites: [] });
      const c = new DentallyClient({ apiKey: "k", baseUrl: "https://x", fetchImpl: fetchMock, readOnly: true });
      await c.listSites();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // The mutation guard. Without readOnly the same call must reach fetch, or the
    // tests above would pass against a client that simply never writes at all.
    it("does NOT refuse when readOnly is unset", async () => {
      const fetchMock = mockFetch({ appointment: { id: "a1" } });
      const c = new DentallyClient({ apiKey: "k", baseUrl: "https://x", fetchImpl: fetchMock });
      await c.cancelAppointment("a1");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
