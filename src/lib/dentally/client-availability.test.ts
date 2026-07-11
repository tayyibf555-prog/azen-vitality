import { describe, it, expect, vi } from "vitest";
import { DentallyClient } from "./client";

function mockFetch(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({ ok, status, json: async () => body, text: async () => JSON.stringify(body) });
}

// Calibrated against LIVE Dentally 2026-07-11: availability takes start_time /
// finish_time (ISO datetimes) + repeated practitioner_ids[] params. The earlier
// site_id/start_date shape 400s with "start_time is missing".
describe("DentallyClient.getAvailability", () => {
  it("queries per practitioner with datetimes, auth + User-Agent", async () => {
    const fetchMock = mockFetch({ availability: [] });
    const c = new DentallyClient({ apiKey: "k", baseUrl: "https://api.sandbox.dentally.co", fetchImpl: fetchMock });
    await c.getAvailability({
      practitionerIds: [10383, "238619"],
      startTime: "2026-06-22T09:00:00.000Z",
      finishTime: "2026-06-29T23:59:59.999Z",
      duration: 30,
    });
    const [url, init] = fetchMock.mock.calls[0];
    const u = new URL(String(url));
    expect(u.pathname).toContain("/v1/appointments/availability");
    expect(u.searchParams.get("start_time")).toBe("2026-06-22T09:00:00.000Z");
    expect(u.searchParams.get("finish_time")).toBe("2026-06-29T23:59:59.999Z");
    expect(u.searchParams.get("duration")).toBe("30");
    // Rails-style repeated array param, one entry per practitioner.
    expect(u.searchParams.getAll("practitioner_ids[]")).toEqual(["10383", "238619"]);
    // The stale calibration must be gone entirely.
    expect(u.searchParams.get("site_id")).toBeNull();
    expect(u.searchParams.get("start_date")).toBeNull();
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer k");
    expect((init.headers as Record<string, string>)["User-Agent"]).toBeTruthy();
  });
});

describe("DentallyClient.listPractitioners", () => {
  it("lists a site's practitioners", async () => {
    const fetchMock = mockFetch({ practitioners: [] });
    const c = new DentallyClient({ apiKey: "k", baseUrl: "https://api.sandbox.dentally.co", fetchImpl: fetchMock });
    await c.listPractitioners("3286d822-68c5-48ff-b1a2-065780dfcd15");
    const u = new URL(String(fetchMock.mock.calls[0][0]));
    expect(u.pathname).toContain("/v1/practitioners");
    expect(u.searchParams.get("site_id")).toBe("3286d822-68c5-48ff-b1a2-065780dfcd15");
  });
});
