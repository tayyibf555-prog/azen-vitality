// PUBLIC GET /api/booking/slots: read-only availability for the booking
// calendar. Defends the cross-tenant 404, the 14-day range clamp, the 30s
// in-module cache (one browsing patient must not hammer Dentally), and the
// friendly 502 on a Dentally failure.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  getAvailability: vi.fn(async (..._a: unknown[]) => ({ availability: [] as unknown[] })),
}));

vi.mock("@/lib/dentally/write", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    dentallyAgentClient: () => ({ getAvailability: h.getAvailability }),
  };
});

import { GET } from "./route";

const DAY_MS = 86_400_000;
function ymd(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

function get(params: Record<string, string>): Promise<Response> {
  const qs = new URLSearchParams(params).toString();
  return GET(new Request(`http://localhost/api/booking/slots?${qs}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getAvailability.mockResolvedValue({ availability: [] });
});

describe("GET /api/booking/slots", () => {
  it("404s an unknown client and a site that is not the client's own", async () => {
    expect((await get({ client: "nope", site: "site-cc" })).status).toBe(404);
    expect((await get({ client: "vitality", site: "site-of-another-tenant" })).status).toBe(404);
    expect(h.getAvailability).not.toHaveBeenCalled();
  });

  it("returns future slots grouped into days, querying Dentally with the site UUID", async () => {
    const from = ymd(1);
    const start = `${from}T10:00:00.000Z`;
    const finish = `${from}T10:30:00.000Z`;
    h.getAvailability.mockResolvedValue({
      availability: [{ start_time: start, finish_time: finish, practitioner_id: 7 }],
    });
    const res = await get({ client: "vitality", site: "site-cc", from, to: ymd(2) });
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      ok: boolean;
      days: Array<{ date: string; slots: Array<{ start: string; finish: string; practitionerId: string | null }> }>;
    };
    expect(j.ok).toBe(true);
    expect(j.days).toHaveLength(1);
    expect(j.days[0]!.slots).toEqual([{ start, finish, practitionerId: "7" }]);
    const arg = h.getAvailability.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.siteId).toBe("3286d822-68c5-48ff-b1a2-065780dfcd15");
    expect(arg.duration).toBe(30);
  });

  it("clamps the requested range to 14 days", async () => {
    const from = ymd(3);
    const res = await get({ client: "vitality", site: "site-rv", from, to: ymd(40) });
    expect(res.status).toBe(200);
    const arg = h.getAvailability.mock.calls[0]![0] as { fromDate: string; toDate: string };
    expect(arg.fromDate).toBe(from);
    expect(Date.parse(arg.toDate) - Date.parse(arg.fromDate)).toBe(13 * DAY_MS);
  });

  it("rejects malformed dates cleanly", async () => {
    const res = await get({ client: "vitality", site: "site-cc", from: "junk", to: ymd(2) });
    expect(res.status).toBe(400);
    expect(h.getAvailability).not.toHaveBeenCalled();
  });

  it("serves a repeat of the same site+range from the 30s cache (one Dentally read)", async () => {
    const params = { client: "vitality", site: "site-ng", from: ymd(5), to: ymd(6) };
    expect((await get(params)).status).toBe(200);
    expect((await get(params)).status).toBe(200);
    expect(h.getAvailability).toHaveBeenCalledTimes(1);
  });

  it("maps a Dentally failure to a friendly 502, never a crash", async () => {
    h.getAvailability.mockRejectedValue(new Error("boom"));
    const res = await get({ client: "vitality", site: "site-cc", from: ymd(7), to: ymd(8) });
    expect(res.status).toBe(502);
    const j = (await res.json()) as { ok: boolean; error: string };
    expect(j.ok).toBe(false);
    expect(j.error).not.toContain("boom");
  });
});
