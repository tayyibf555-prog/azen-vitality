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
});
