// PUBLIC GET /api/booking/slots: read-only availability for the booking
// calendar. Defends the cross-tenant 404, the 14-day range clamp, the 30s
// in-module cache (one browsing patient must not hammer Dentally), and the
// friendly 502 on a Dentally failure.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  getAvailability: vi.fn(async (..._a: unknown[]) => ({ availability: [] as unknown[] })),
  // Two active practitioners by default (availability is per practitioner on live Dentally).
  listPractitioners: vi.fn(async (siteId: string) => ({
    practitioners: [
      { id: 7, active: true, site_id: siteId },
      { id: 8, active: true, site_id: siteId },
    ],
  })),
  // Must stay untouched: this is a READ route, so the write client has no
  // business on its path. See slots-read-client.test.ts for why.
  dentallyAgentClient: vi.fn(() => {
    throw new Error("the public availability read must not build the write client");
  }),
}));

vi.mock("@/lib/dentally/read", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    dentallyFromEnv: () => ({ getAvailability: h.getAvailability, listPractitioners: h.listPractitioners }),
  };
});

vi.mock("@/lib/dentally/write", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, dentallyAgentClient: h.dentallyAgentClient };
});

import { GET } from "./route";

const DAY_MS = 86_400_000;
function ymd(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

/** The Europe/London calendar day of an ISO instant (en-CA renders YYYY-MM-DD). */
function londonDay(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date(iso));
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
    // Practitioners are listed for the site's Dentally UUID; availability then
    // covers all active ids with datetimes at the booking duration.
    expect(h.listPractitioners).toHaveBeenCalledWith("3286d822-68c5-48ff-b1a2-065780dfcd15");
    const arg = h.getAvailability.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.practitionerIds).toEqual(["7", "8"]);
    expect(arg.duration).toBe(30);
  });

  it("clamps the requested range to 14 days, spanning whole Europe/London days", async () => {
    const from = ymd(3);
    const res = await get({ client: "vitality", site: "site-rv", from, to: ymd(40) });
    expect(res.status).toBe(200);
    const arg = h.getAvailability.mock.calls[0]![0] as { startTime: string; finishTime: string };
    // The range ends are LONDON day boundaries, so on BST the UTC date of the
    // start instant is the previous day. Assert the London day, which is what
    // the practice and the patient actually mean by "that day".
    expect(londonDay(arg.startTime)).toBe(from);
    // finish = from + 13 days, end of the London day.
    expect(londonDay(arg.finishTime)).toBe(ymd(3 + 13));
  });

  // PIN CORRECTED — the route used to clamp a backwards range to `to = from`.
  //
  // A patient who tapped the later day first got ONE day back, a 200, and no hint
  // that the days between had been dropped: an open calendar looked all but shut.
  // Meanwhile the agent tool swapped the same pair and the booking module trimmed
  // nothing, so one question had three answers. The seam decides it now
  // (orderedDayRange, applied inside bookingAvailabilityWindow), and this route
  // reads that same function rather than holding a second opinion.
  it("serves a reversed from/to as the WHOLE range, not the single day the old clamp left", async () => {
    const from = ymd(6);
    const to = ymd(2);
    const res = await get({ client: "vitality", site: "site-cc", from, to });
    expect(res.status).toBe(200);
    const arg = h.getAvailability.mock.calls[0]![0] as { startTime: string; finishTime: string };
    expect(londonDay(arg.startTime)).toBe(to); // the earlier day starts the window
    expect(londonDay(arg.finishTime)).toBe(from); // and the later one ends it
  });

  it("still bounds a reversed range at 14 days, which the old clamp never had to", async () => {
    // Reversed, the span reads NEGATIVE and slipped past the 14-day check
    // untouched; only the to=from clamp hid how wide it really was.
    const res = await get({ client: "vitality", site: "site-cc", from: ymd(40), to: ymd(3) });
    expect(res.status).toBe(200);
    const arg = h.getAvailability.mock.calls[0]![0] as { startTime: string; finishTime: string };
    expect(londonDay(arg.startTime)).toBe(ymd(3));
    expect(londonDay(arg.finishTime)).toBe(ymd(3 + 13));
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
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await get({ client: "vitality", site: "site-cc", from: ymd(7), to: ymd(8) });
    expect(res.status).toBe(502);
    const j = (await res.json()) as { ok: boolean; error: string };
    expect(j.ok).toBe(false);
    expect(j.error).not.toContain("boom");
    // The cause is logged SERVER SIDE (it used to be swallowed entirely, which is
    // how a dead production calendar stayed invisible) and never sent to the patient.
    expect(spy.mock.calls.flat().join(" ")).toContain("boom");
    spy.mockRestore();
  });

  it("never builds the WRITE client: availability is a read", async () => {
    // The mocked dentallyAgentClient throws if called, so a route that reached
    // for it would 502 here instead of serving times. Belt to the credential
    // assertions in slots-read-client.test.ts.
    const res = await get({ client: "vitality", site: "site-cc", from: ymd(9), to: ymd(10) });
    expect(res.status).toBe(200);
    expect(h.dentallyAgentClient).not.toHaveBeenCalled();
  });

  // A RANGE THAT REACHES TODAY IS SERVED FROM TODAY, NOT ABANDONED IN THE PAST.
  //
  // `from` defaults to today, so `?to=<a date weeks back>` arrives as the ordered
  // range [pastTo..today]. The 14-day clamp then measured its fortnight from
  // `pastTo` and handed the booking seam [pastTo..pastTo+13] — a window entirely
  // in the past, which Dentally can never answer for, so the seam refused it
  // without asking and the patient got a cheerful 200 with an EMPTY calendar on a
  // day the practice was open. (The older clamp-to-`from` spelling served today.)
  //
  // The clock is frozen so "today" is a fact rather than a race: at the boundary
  // of a real London day these ranges would otherwise mean different things
  // between one assertion and the next.
  describe("a past `to`, and a range with no future left in it", () => {
    const NOW_ISO = "2026-08-21T14:17:33.000+01:00"; // a BST afternoon
    const TODAY = "2026-08-21";

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(NOW_ISO));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("serves TODAY for a lone past `to`, instead of the empty calendar the clamp made of it", async () => {
      h.getAvailability.mockResolvedValue({
        availability: [
          { start_time: `${TODAY}T15:00:00.000+01:00`, finish_time: `${TODAY}T16:00:00.000+01:00`, practitioner_id: 7 },
        ],
      });
      const res = await get({ client: "vitality", site: "site-cc", to: "2026-07-22" });
      expect(res.status).toBe(200);

      // Dentally is ASKED. Before the anchor there was no call at all: the clamped
      // window had already ended, so the seam answered [] without one.
      expect(h.getAvailability).toHaveBeenCalledTimes(1);
      const arg = h.getAvailability.mock.calls[0]![0] as { startTime: string };
      expect(Date.parse(arg.startTime)).toBeGreaterThan(Date.now());
      expect(londonDay(arg.startTime)).toBe(TODAY);

      // And the patient gets today's real times, not an empty day.
      const j = (await res.json()) as {
        ok: boolean;
        days: Array<{ date: string; slots: unknown[] }>;
        rangeInPast?: boolean;
      };
      expect(j.ok).toBe(true);
      expect(j.days.map((d) => d.date)).toEqual([TODAY]);
      expect(j.days[0]!.slots).toHaveLength(2); // 15:00 and 15:30
      // Nothing was refused, so nothing is marked as past.
      expect(j.rangeInPast).toBeUndefined();
    });

    it("marks a range ENTIRELY in the past, rather than passing it off as no availability", async () => {
      const res = await get({ client: "vitality", site: "site-cc", from: "2026-07-01", to: "2026-07-10" });
      expect(res.status).toBe(200);
      const j = (await res.json()) as { ok: boolean; days: unknown[]; rangeInPast?: boolean };

      // Still a 200 and still an honest empty list — nothing IS free on days that
      // have ended — but `{days: []}` alone is the same answer a fully booked
      // practice gives. This bit is what lets the widget tell them apart.
      expect(j.ok).toBe(true);
      expect(j.days).toEqual([]);
      expect(j.rangeInPast).toBe(true);
      // Nothing is asked of Dentally for days it could never answer for.
      expect(h.getAvailability).not.toHaveBeenCalled();
      expect(h.listPractitioners).not.toHaveBeenCalled();
    });

    it("still bounds a range that STARTS in the past at 14 days from today, not from the start", async () => {
      // The anchor moves the start; the fortnight is then measured from there, so a
      // month-long ask still reads a fortnight of real, future days.
      const res = await get({ client: "vitality", site: "site-rv", from: "2026-07-25", to: "2026-09-30" });
      expect(res.status).toBe(200);
      const arg = h.getAvailability.mock.calls[0]![0] as { startTime: string; finishTime: string };
      expect(londonDay(arg.startTime)).toBe(TODAY);
      expect(londonDay(arg.finishTime)).toBe("2026-09-03"); // today + 13 days
    });
  });
});
