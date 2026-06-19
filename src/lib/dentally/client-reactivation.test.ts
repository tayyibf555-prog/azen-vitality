import { describe, it, expect, vi } from "vitest";
import { DentallyClient } from "./client";

function mockFetch(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok, status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

describe("DentallyClient dormant-book reads", () => {
  it("listPatients sends auth + User-Agent to the configured base URL", async () => {
    const fetchMock = mockFetch({ patients: [] });
    const c = new DentallyClient({ apiKey: "k", baseUrl: "https://api.sandbox.dentally.co", fetchImpl: fetchMock });
    await c.listPatients({ siteId: "site-cc", page: 1 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("https://api.sandbox.dentally.co");
    expect(String(url)).toContain("site_id=site-cc");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer k");
    expect((init.headers as Record<string, string>)["User-Agent"]).toBeTruthy();
  });

  it("getPatientAppointments and getPatientInvoices query by patient id", async () => {
    const fetchMock = mockFetch({ appointments: [] });
    const c = new DentallyClient({ apiKey: "k", baseUrl: "https://x", fetchImpl: fetchMock });
    await c.getPatientAppointments("123");
    await c.getPatientInvoices("123");
    expect(String(fetchMock.mock.calls[0][0])).toContain("patient_id=123");
    expect(String(fetchMock.mock.calls[1][0])).toContain("patient_id=123");
  });

  it("throws a DentallyError on non-2xx", async () => {
    const fetchMock = mockFetch({ error: "nope" }, false, 401);
    const c = new DentallyClient({ apiKey: "k", baseUrl: "https://x", fetchImpl: fetchMock });
    await expect(c.listPatients({ siteId: "s" })).rejects.toThrow(/401/);
  });
});
