import { describe, it, expect, vi } from "vitest";
import { DentallyClient } from "./client";

function mockFetch(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({ ok, status, json: async () => body, text: async () => JSON.stringify(body) });
}

describe("DentallyClient.getAvailability", () => {
  it("queries availability by site with auth + User-Agent", async () => {
    const fetchMock = mockFetch({ availability: [] });
    const c = new DentallyClient({ apiKey: "k", baseUrl: "https://api.sandbox.dentally.co", fetchImpl: fetchMock });
    await c.getAvailability({ siteId: "site-cc", fromDate: "2026-06-22", toDate: "2026-06-29" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/v1/appointments/availability");
    expect(String(url)).toContain("site_id=site-cc");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer k");
    expect((init.headers as Record<string, string>)["User-Agent"]).toBeTruthy();
  });
});
