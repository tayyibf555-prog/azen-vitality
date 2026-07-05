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
});
