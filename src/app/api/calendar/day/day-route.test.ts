// ===========================================================================
// GET /api/calendar/day: what it will and will not agree to read.
//
// The route's own header calls it "one to seven London days", and the ceiling is
// there for a reason: both endpoints are handed straight to the Dentally
// appointment scan and to the availability read AS A RANGE. Counting the keys is
// therefore not enough. Two keys a decade apart is a decade-wide read of every
// practitioner at the site, against a shared rate budget, from a request that
// passes a count of two.
// ===========================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  listAppointments: vi.fn(async () => ({ appointments: [], failed: false, failedSiteIds: [] as string[] })),
  loadDiaryDay: vi.fn(async () => ({
    siteId: "site-cc",
    dayKeys: [] as string[],
    windows: [],
    funding: {},
    entries: [],
    unconfirmed: [],
    availabilityFailed: false,
    unanswerableDayKeys: [] as string[],
    answerableFromMin: {} as Record<string, number>,
    fundingFailed: false,
    entriesFailed: false,
  })),
}));

vi.mock("@/lib/calendar/access", () => ({
  requireDiaryRead: async () => ({ auth: null, siteId: "site-cc", clientId: "vitality" }),
}));

// The route now also carries the MODULE gate, which requireDiaryRead is not a
// substitute for: it proves the caller holds the site, and every client role holds
// every site of its own practice. The real predicate is used here, with the mocked
// `auth: null` above meaning enforcement-off, so it passes through exactly as the
// real guard does in the un-enforced pilot.
vi.mock("@/lib/auth/guard", async () => {
  const { canRoleAccessModule } = await import("@/lib/nav");
  return {
    requireModuleApiAccess: (u: { role?: string } | null, slug: string) =>
      u && !canRoleAccessModule(u.role as Parameters<typeof canRoleAccessModule>[0], slug)
        ? Response.json({ ok: false, error: "forbidden" }, { status: 403 })
        : null,
  };
});

vi.mock("@/lib/dentally/read", () => ({
  listAppointmentsSafe: h.listAppointments,
  listSitePractitionersSafe: async () => ({ practitioners: [{ id: "prac-1", name: "Jin Kim" }], failed: false }),
}));

vi.mock("@/lib/calendar/day-load", () => ({
  MAX_DIARY_DAYS: 7,
  loadDiaryDay: h.loadDiaryDay,
}));

import { GET } from "./route";

async function call(days: string): Promise<{ res: Response; json: Record<string, unknown> }> {
  const res = await GET(
    new Request(`http://localhost/api/calendar/day?site=site-cc&days=${encodeURIComponent(days)}`),
  );
  return { res, json: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the day range", () => {
  it("reads one day", async () => {
    const { res, json } = await call("2026-07-31");
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(h.listAppointments).toHaveBeenCalledWith(["site-cc"], { from: "2026-07-31", to: "2026-07-31" });
  });

  it("reads a full seven day week", async () => {
    const week = [
      "2026-07-27",
      "2026-07-28",
      "2026-07-29",
      "2026-07-30",
      "2026-07-31",
      "2026-08-01",
      "2026-08-02",
    ].join(",");
    const { res } = await call(week);
    expect(res.status).toBe(200);
  });

  it("REFUSES two keys a decade apart, which the count check waves through", async () => {
    const { res, json } = await call("2020-01-01,2030-01-01");
    expect(res.status).toBe(400);
    expect(String(json.error)).toContain("range");
    // Nothing was read at all: the refusal comes before the scan, or it has not
    // saved anything.
    expect(h.listAppointments).not.toHaveBeenCalled();
    expect(h.loadDiaryDay).not.toHaveBeenCalled();
  });

  it("refuses a range one day over the ceiling, not merely an absurd one", async () => {
    const { res } = await call("2026-07-31,2026-08-07");
    expect(res.status).toBe(400);
    expect(h.listAppointments).not.toHaveBeenCalled();
  });

  it("still refuses more than seven keys", async () => {
    const { res, json } = await call(
      "2026-07-27,2026-07-28,2026-07-29,2026-07-30,2026-07-31,2026-08-01,2026-08-02,2026-08-03",
    );
    expect(res.status).toBe(400);
    expect(String(json.error)).toContain("7 days or fewer");
  });

  it("refuses a malformed key before it can reach the span arithmetic", async () => {
    const { res, json } = await call("2026-07-31,not-a-day");
    expect(res.status).toBe(400);
    expect(String(json.error)).toContain("YYYY-MM-DD");
    expect(h.listAppointments).not.toHaveBeenCalled();
  });

  it("requires at least one day", async () => {
    const { res } = await call("");
    expect(res.status).toBe(400);
  });
});

describe("the days Dentally cannot answer for", () => {
  it("reaches the client, so a past day can hatch instead of claiming nobody worked", () => {
    // The whole point of the flag is that it is SERVER-computed: the board must
    // not have to decide from its own clock what "already over" means. If the
    // route drops it, every elapsed column silently reverts to grey -- a positive
    // claim that the practice was shut, from a question nobody could ask.
    h.loadDiaryDay.mockResolvedValueOnce({
      siteId: "site-cc",
      dayKeys: ["2026-07-27"],
      windows: [],
      funding: {},
      entries: [],
      unconfirmed: [],
      availabilityFailed: false,
      unanswerableDayKeys: ["2026-07-27"],
      answerableFromMin: {} as Record<string, number>,
      fundingFailed: false,
      entriesFailed: false,
    });
    return call("2026-07-27").then(({ res, json }) => {
      expect(res.status).toBe(200);
      expect(json.availabilityFailed).toBe(false);
      expect(json.unanswerableDayKeys).toEqual(["2026-07-27"]);
    });
  });

  it("carries the minute TODAY's answer begins at, so the morning is not claimed as 'off'", () => {
    // Server-computed for exactly the same reason, and needed far more often:
    // every day is a partly-elapsed today at some point in the afternoon. Drop it
    // here and a clinician who worked all morning with nothing booked reads as
    // "Not working" from lunchtime.
    h.loadDiaryDay.mockResolvedValueOnce({
      siteId: "site-cc",
      dayKeys: ["2026-07-31"],
      windows: [],
      funding: {},
      entries: [],
      unconfirmed: [],
      availabilityFailed: false,
      unanswerableDayKeys: [] as string[],
      answerableFromMin: { "2026-07-31": 902 },
      fundingFailed: false,
      entriesFailed: false,
    });
    return call("2026-07-31").then(({ res, json }) => {
      expect(res.status).toBe(200);
      expect(json.answerableFromMin).toEqual({ "2026-07-31": 902 });
    });
  });
});
