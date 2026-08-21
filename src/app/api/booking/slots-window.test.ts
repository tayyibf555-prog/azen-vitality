// A PATIENT ASKING ABOUT ONE DAY WAS TOLD THE PRACTICE WAS SHUT.
//
// /api/booking/slots?from=X&to=X is what the picker sends the moment a patient
// looks at a single day. The reader passed that range straight to Dentally's
// GET /v1/appointments/availability, which VALIDATES the window before it looks
// at anything and refuses a span of 24 hours or less (measured against live
// Dentally, 2026-08-21: now+1min -> now+23h is a 400, now+1min -> now+25h is a
// 200). A London day is 24 hours MINUS a millisecond, so every single-day
// request 400d, the route's catch turned that into "we could not load available
// times right now", and a fully open practice looked closed.
//
// Nothing about it was visible in manual testing: the 14-day DEFAULT range
// spans a fortnight and always cleared the rule.
//
// This drives the real route handler -- real budget wrapper, real cross-tenant
// guard, real cache, real reader -- against a recording stand-in for Dentally,
// so what is pinned is the request that would go on the wire.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const state = vi.hoisted(() => ({
  asked: [] as Array<{ startTime: string; finishTime: string }>,
  practitionerCalls: 0,
  windows: [] as Array<[string, string]>,
}));

vi.mock("@/lib/dentally/read", () => ({
  dentallyFromEnv: () => ({
    async listPractitioners() {
      state.practitionerCalls += 1;
      return { practitioners: [{ id: 5, active: true }] };
    },
    async getAvailability(a: { startTime: string; finishTime: string }) {
      state.asked.push({ startTime: a.startTime, finishTime: a.finishTime });
      const from = Date.parse(a.startTime);
      const to = Date.parse(a.finishTime);
      return {
        availability: state.windows
          .filter(([s, f]) => Date.parse(f) > from && Date.parse(s) < to)
          .map(([s, f]) => ({ start_time: s, finish_time: f, practitioner_id: 5 })),
      };
    },
  }),
}));

// 10:17 London on a BST Friday. Frozen, so the fortnight-wide default range and
// the one-day range are compared at the same instant and the route's own 30
// second cache cannot expire mid-test.
const NOW_ISO = "2026-08-21T09:17:31.412Z";
const TODAY = "2026-08-21";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW_ISO));
  state.asked = [];
  state.practitionerCalls = 0;
  state.windows = [];
  // A fresh module means a fresh in-module cache, so one test cannot serve
  // another one's answer.
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
});

async function get(query: string): Promise<{ status: number; body: { ok: boolean; days?: Array<{ date: string; slots: unknown[] }>; error?: string } }> {
  const { GET } = await import("@/app/api/booking/slots/route");
  const res = await GET(new Request(`https://example.test/api/booking/slots?${query}`));
  return { status: res.status, body: await res.json() };
}

const SITE = "client=vitality&site=site-cc";

describe("/api/booking/slots for a SINGLE day", () => {
  it("sends Dentally a window it will accept: start in the future, finish more than 24h later", async () => {
    state.windows = [["2026-08-21T13:00:00.000Z", "2026-08-21T15:00:00.000Z"]];
    const { status, body } = await get(`${SITE}&from=${TODAY}&to=${TODAY}`);

    expect(status).toBe(200);
    expect(body.ok, `the route answered: ${body.error ?? ""}`).toBe(true);
    expect(state.asked).toHaveLength(1);

    const { startTime, finishTime } = state.asked[0]!;
    const nowMs = Date.parse(NOW_ISO);
    expect(Date.parse(startTime), "start_time must be in the future").toBeGreaterThan(nowMs);
    expect(
      Date.parse(finishTime) - Date.parse(startTime),
      "finish_time must be greater than 24 hours after start_time",
    ).toBeGreaterThan(24 * 3_600_000);
  });

  it("still answers with that day's REAL times, which is the whole point", async () => {
    state.windows = [["2026-08-21T13:00:00.000Z", "2026-08-21T15:00:00.000Z"]];
    const { body } = await get(`${SITE}&from=${TODAY}&to=${TODAY}`);
    expect(body.days).toHaveLength(1);
    expect(body.days![0]!.date).toBe(TODAY);
    expect(body.days![0]!.slots, "a fully open day must not come back empty").toHaveLength(4);
  });

  it("TRIMS the wider window back: the patient never sees a day they did not ask for", async () => {
    state.windows = [
      ["2026-08-21T13:00:00.000Z", "2026-08-21T15:00:00.000Z"],
      ["2026-08-22T09:00:00.000Z", "2026-08-22T11:00:00.000Z"],
    ];
    const { body } = await get(`${SITE}&from=${TODAY}&to=${TODAY}`);
    expect(body.days!.map((d) => d.date)).toEqual([TODAY]);
  });

  it("leaves the 14-day default range exactly as it was", async () => {
    state.windows = [["2026-08-25T09:00:00.000Z", "2026-08-25T10:00:00.000Z"]];
    const { body } = await get(SITE);
    expect(body.ok).toBe(true);
    const { startTime, finishTime } = state.asked[0]!;
    expect(startTime).toBe("2026-08-21T09:30:00.000Z");
    expect(finishTime).toBe("2026-09-03T22:59:59.999Z");
  });
});

describe("/api/booking/slots for a range that has already ended", () => {
  it("issues NO Dentally request at all", async () => {
    const { body } = await get(`${SITE}&from=2026-08-18&to=2026-08-19`);
    expect(state.asked).toEqual([]);
    expect(state.practitionerCalls, "a past range must not cost a practitioner read either").toBe(0);
    expect(body.ok).toBe(true);
  });

  it("answers with no days, and NOT with an error", async () => {
    const { status, body } = await get(`${SITE}&from=2026-08-18&to=2026-08-19`);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.days).toEqual([]);
    expect(body.error).toBeUndefined();
  });
});
