import { describe, it, expect } from "vitest";
import { GET } from "./route";
import { diaryAvailabilityRequest, londonInstantMs, nextDayKey } from "@/lib/calendar/availability";
import { londonDayKey } from "@/lib/time/london";

// ===========================================================================
// THE WINDOW LIVE REFUSES — and which this mock used to answer 200 for.
//
// GET /v1/appointments/availability validates the window before it looks at a single
// diary, and refuses two shapes with 400 "The appointment could not be processed":
//
//     start_time   "must be in the future"           -- a start at or before now
//     finish_time  "must be greater than 24 hours"   -- a span of 24h or less
//
// MEASURED against live 2026-08-21, read-only key:
//     today 00:00 -> today 23:59    400, BOTH params
//     now+1min    -> now+23h        400, finish_time only
//     now+1min    -> now+25h        200
//
// WHY THIS TEST EXISTS. Until now the mock answered 200 for any window it could
// PARSE, so a caller that built a window live refuses looked perfect locally and
// failed in the practice. It did, twice: the diary first, then the booking picker,
// where `?from=X&to=X` — what the picker sends the instant a patient asks about ONE
// day — spans at most 24 hours, 400d, and the route's catch turned that into "we
// could not load available times" on a day the practice was fully open. Both callers
// were fixed; neither fix could be PINNED, because a mock that accepts everything
// cannot tell a compliant window from a non-compliant one.
//
// These tests are the pin. A mock that models an API's limitation has to be RIGHT
// about the limitation: looser than live, and tests pass on behaviour live refuses.
// ===========================================================================

const HOUR = 3_600_000;
const AUTH = { headers: { authorization: "Bearer test-token" } } as const;

interface Refusal {
  status: number;
  type?: string;
  message?: string;
  params?: Record<string, string[]>;
  rows?: unknown[];
}

async function ask(startTime: string, finishTime: string, ids: string[] = ["prac-1"]): Promise<Refusal> {
  const url = new URL("http://localhost/api/mock-dentally/v1/appointments/availability");
  url.searchParams.set("start_time", startTime);
  url.searchParams.set("finish_time", finishTime);
  for (const id of ids) url.searchParams.append("practitioner_ids[]", id);
  const res = await GET(new Request(url.href, AUTH));
  const json = (await res.json()) as {
    error?: { type?: string; message?: string; params?: Record<string, string[]> };
    availability?: unknown[];
  };
  return {
    status: res.status,
    type: json.error?.type,
    message: json.error?.message,
    params: json.error?.params,
    rows: json.availability,
  };
}

const iso = (ms: number): string => new Date(ms).toISOString();

describe("mock availability: the windows live refuses", () => {
  it("400s a start_time in the PAST, naming only start_time when the span is fine", async () => {
    const now = Date.now();
    const res = await ask(iso(now - HOUR), iso(now + 30 * HOUR));

    expect(res.status).toBe(400);
    expect(res.type).toBe("invalid_request_error");
    expect(res.message).toBe("The appointment could not be processed");
    expect(res.params).toEqual({ start_time: ["must be in the future"] });
    expect(res.rows, "a refusal carries no availability at all").toBeUndefined();
  });

  it("400s a span of 24 hours or less, naming only finish_time when the start is fine", async () => {
    const now = Date.now();
    // The measured live case: now+1min -> now+23h.
    const start = now + 60_000;
    const res = await ask(iso(start), iso(start + 23 * HOUR));

    expect(res.status).toBe(400);
    expect(res.type).toBe("invalid_request_error");
    expect(res.message).toBe("The appointment could not be processed");
    expect(res.params).toEqual({ finish_time: ["must be greater than 24 hours"] });
  });

  it("names BOTH params when both rules are broken — the today 00:00 -> today 23:59 case", async () => {
    // The live case this models is a whole calendar day: a start already past, and a
    // span of 23h59m. It is built from `now` rather than from a day key, because a
    // LONDON day key stamped with a UTC "Z" is up to an hour in the FUTURE between
    // 23:00 and 00:00 UTC — so through BST this test failed for one hour every night
    // (the start was not yet past, and only the span rule fired) and passed the rest
    // of the time. The shape under test is the two broken rules, not today's date.
    const start = Date.now() - 60_000;
    const res = await ask(iso(start), iso(start + 23 * HOUR + 59 * 60_000));

    expect(res.status).toBe(400);
    expect(res.params).toEqual({
      start_time: ["must be in the future"],
      finish_time: ["must be greater than 24 hours"],
    });
  });

  it("refuses EXACTLY 24 hours: the rule is GREATER than 24, so the boundary is out", async () => {
    const now = Date.now();
    const start = now + HOUR;

    const exactly24 = await ask(iso(start), iso(start + 24 * HOUR));
    expect(exactly24.status, "24h exactly must be refused").toBe(400);
    expect(exactly24.params).toEqual({ finish_time: ["must be greater than 24 hours"] });

    // One millisecond over the boundary is accepted, which is what makes the
    // comparison strict rather than approximate.
    const justOver = await ask(iso(start), iso(start + 24 * HOUR + 1));
    expect(justOver.status, "24h + 1ms must be accepted").toBe(200);
  });

  it("refuses a start_time of exactly now: 'in the future' is STRICT", async () => {
    // A window built from a raw `now` is the single most likely mistake a caller
    // makes, and it is the one live rejects.
    const now = Date.now();
    const res = await ask(iso(now), iso(now + 30 * HOUR));
    expect(res.status).toBe(400);
    expect(res.params?.start_time).toEqual(["must be in the future"]);
  });

  it("answers 200 for the measured-good window and actually returns diary rows", async () => {
    const now = Date.now();
    const start = now + 60_000;
    const res = await ask(iso(start), iso(start + 7 * 24 * HOUR));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.rows)).toBe(true);
    expect(
      (res.rows ?? []).length,
      "a compliant week-long window over a rostered clinician must not be empty",
    ).toBeGreaterThan(0);
  });

  it("validates the window BEFORE anything else, so a bad window 400s even for a practitioner who does not exist", async () => {
    const now = Date.now();
    const res = await ask(iso(now - HOUR), iso(now + HOUR), ["prac-does-not-exist"]);
    expect(res.status).toBe(400);
    expect(res.params).toEqual({
      start_time: ["must be in the future"],
      finish_time: ["must be greater than 24 hours"],
    });
  });

  it("still 400s a MISSING window with the missing-parameter shape, not the window shape", async () => {
    const url = new URL("http://localhost/api/mock-dentally/v1/appointments/availability");
    const res = await GET(new Request(url.href, AUTH));
    const json = (await res.json()) as { error: { params: Record<string, string[]> } };
    expect(res.status).toBe(400);
    expect(json.error.params).toEqual({
      start_time: ["is missing"],
      finish_time: ["is missing"],
    });
  });

  it("accepts the window the DIARY builds, for every range including a single past-ish day", async () => {
    // diaryAvailabilityRequest is the shared helper both fixed callers use. If the
    // mock and that helper ever disagree, one of them is wrong about live — and this
    // is the seam where that is cheap to discover.
    const now = Date.now();
    const today = londonDayKey(new Date(now));
    // The next London day comes from the day KEY, never from `now + 24h`: the
    // October fall-back day is twenty-five hours long, so between 00:00 and 01:00
    // BST that arithmetic lands back on TODAY and all three legs below collapse
    // into one, silently.
    const tomorrow = nextDayKey(today);

    // WHY THE PAST-ISH LEG CARRIES ITS OWN `now`.
    //
    // diaryAvailabilityRequest deliberately returns null when the requested range
    // ends within AVAILABILITY_START_BUFFER_MS (2 minutes) of `now` — there is
    // nothing left to ask Dentally about. For a range of [today, today] that is
    // true from 23:58 Europe/London, so a leg driven by the real clock reddened
    // this file for the last two minutes of every day while the product code was
    // exactly right. That is the sibling of the London-day-key-stamped-with-a-UTC-Z
    // bomb fixed three tests above, and it is invisible to a grep because the
    // fixture holds no date literal at all.
    //
    // What this leg is about is the SHAPE — a SINGLE day whose midnight has already
    // gone by, which is the booking picker's `?from=X&to=X`, the window live 400s —
    // and not today's date. Pinning its `now` to noon of the day reproduces that
    // shape exactly (the start clamps forward, the span expands to the 25-hour
    // minimum) at every instant of the real clock. The day is TOMORROW so the
    // window the helper hands back is still strictly in the real future, which is
    // what the mock actually validates against.
    const noonTomorrow = londonInstantMs(tomorrow, 12, 0);

    for (const leg of [
      { label: "a single day whose midnight has passed", from: tomorrow, to: tomorrow, nowMs: noonTomorrow },
      { label: "today through tomorrow", from: today, to: tomorrow, nowMs: now },
      { label: "a single day still entirely ahead", from: tomorrow, to: tomorrow, nowMs: now },
    ]) {
      const built = diaryAvailabilityRequest({ fromDayKey: leg.from, toDayKey: leg.to, nowMs: leg.nowMs });
      expect(built, `the diary must build a request for ${leg.label} (${leg.from}..${leg.to})`).not.toBeNull();
      const res = await ask(built!.startTime, built!.finishTime);
      expect(
        res.status,
        `live would refuse the window the diary built for ${leg.label}: ${JSON.stringify(res.params)}`,
      ).toBe(200);
    }
  });
});
