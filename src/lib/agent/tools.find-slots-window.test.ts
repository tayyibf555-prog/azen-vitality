// find_slots asks Dentally for a window Dentally will actually ANSWER.
//
// GET /v1/appointments/availability validates the window before it looks at
// anything and refuses two shapes outright (400, "The appointment could not be
// processed"), measured against live Dentally on 2026-08-21:
//
//   start_time  "must be in the future"           -- a start at or before now
//   finish_time "must be greater than 24 hours"   -- a span of 24h or less
//
// The conversational agent was the THIRD caller of that endpoint and the last one
// building its own window: start = max(fromDate, now-on-the-grid), finish = the
// requested day's 23:59:59.999Z. A patient asking "what have you got tomorrow?"
// therefore spanned exactly one day, 400d every time, and the agent answered that
// nothing was free on a day the practice was fully open.
//
// The window is the booking module's now (bookingAvailabilityWindow), so there is
// ONE description of what Dentally accepts. These tests pin the four properties
// that fix has to have, against a stub that enforces Dentally's own rules.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeDispatch } from "./tools";
import type { AgentContext } from "./types";

const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;

// A BST afternoon, deliberately NOT on the half hour: London is +01:00 here, so a
// London day is not a UTC day and the grid clamp has something to round.
const NOW_ISO = "2026-08-21T14:17:33.000+01:00";
const TODAY = "2026-08-21";
const TOMORROW = "2026-08-22";
const DAY_AFTER = "2026-08-23";

interface WindowSent {
  startTime: string;
  finishTime: string;
}

/**
 * An availability reader that VALIDATES like live Dentally: a window breaking
 * either rule throws the 400 instead of answering, exactly as the practice's own
 * API does. Rows come back whole (live does not clip them to start_time), which
 * is precisely why the answer has to be trimmed back to the requested days.
 */
function strictDentally(rows: unknown[]) {
  const sent: WindowSent[] = [];
  return {
    sent,
    listPractitioners: vi.fn(async () => ({
      practitioners: [
        { id: "p1", active: true },
        { id: "p2", active: true },
      ],
    })),
    getAvailability: vi.fn(async (a: { startTime: string; finishTime: string }) => {
      const startMs = Date.parse(a.startTime);
      const finishMs = Date.parse(a.finishTime);
      const refusals: string[] = [];
      if (!(startMs > Date.now())) refusals.push("start_time must be in the future");
      if (!(finishMs - startMs > 24 * HOUR_MS)) refusals.push("finish_time must be greater than 24 hours");
      if (refusals.length > 0) {
        throw new Error(`Dentally 400 The appointment could not be processed: ${refusals.join("; ")}`);
      }
      sent.push({ startTime: a.startTime, finishTime: a.finishTime });
      return { availability: rows };
    }),
    createAppointment: vi.fn(),
    createPatient: vi.fn(),
    getPatientAppointments: vi.fn(),
    updateAppointment: vi.fn(),
    cancelAppointment: vi.fn(),
  };
}

function context(): AgentContext {
  return {
    patientId: "123",
    siteId: "site-cc",
    patientName: "Sam",
    treatment: "hygiene",
    fundingType: null,
  };
}

/** One availability window, in London wall-clock time on a given day. */
function windowOn(day: string, from: string, to: string, offset = "+01:00", practitionerId = "p1") {
  return {
    start_time: `${day}T${from}:00.000${offset}`,
    finish_time: `${day}T${to}:00.000${offset}`,
    practitioner_id: practitionerId,
  };
}

async function findSlots(dentally: unknown, input: Record<string, unknown>) {
  const dispatch = makeDispatch({ dentally, context: context(), writesEnabled: true } as never);
  return JSON.parse(await dispatch("find_slots", input)) as {
    slots: Array<{ start_time: string; finish_time: string; practitioner_id?: string }>;
    error?: string;
  };
}

/** The London calendar day an ISO instant falls on. */
function londonDay(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

// The clock is frozen: every day key below is relative to it, and the whole point
// of the test is what "now" makes of a requested day.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW_ISO));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("find_slots asks for a window live Dentally accepts", () => {
  it('a "what about tomorrow?" ask sends a start strictly in the future and a span over 24 hours', async () => {
    const dentally = strictDentally([windowOn(TOMORROW, "09:00", "12:00")]);
    // The strict stub THROWS a 400 on a non-compliant window, so reaching an answer
    // at all is the assertion; the numbers below say why it was accepted.
    const { slots } = await findSlots(dentally, { treatment: "hygiene", fromDate: TOMORROW, toDate: TOMORROW });

    expect(dentally.sent).toHaveLength(1);
    const { startTime, finishTime } = dentally.sent[0]!;
    expect(Date.parse(startTime)).toBeGreaterThan(Date.now());
    expect(Date.parse(finishTime) - Date.parse(startTime)).toBeGreaterThan(24 * HOUR_MS);
    expect(slots.length).toBeGreaterThan(0);
  });

  it("starts the requested day at LONDON midnight, not UTC midnight, so BST cannot shift it an hour", async () => {
    const dentally = strictDentally([windowOn(TOMORROW, "09:00", "12:00")]);
    await findSlots(dentally, { treatment: "hygiene", fromDate: TOMORROW, toDate: TOMORROW });

    // 2026-08-22 00:00 in London (BST) is 2026-08-21T23:00Z. A UTC-day window would
    // have sent 2026-08-22T00:00Z and missed the first hour of the patient's day.
    expect(dentally.sent[0]!.startTime).toBe("2026-08-21T23:00:00.000Z");
  });

  it("a same-day ask still lands on the absolute 30 minute grid, so the times cannot move under the patient", async () => {
    const dentally = strictDentally([windowOn(TODAY, "15:00", "17:00")]);
    await findSlots(dentally, { treatment: "hygiene", fromDate: TODAY, toDate: TODAY });

    // 14:17:33 London, plus the clock-skew buffer, rounded UP onto the grid: 14:30.
    const startMs = Date.parse(dentally.sent[0]!.startTime);
    expect(startMs % (30 * MIN_MS)).toBe(0);
    expect(startMs).toBe(Date.parse("2026-08-21T14:30:00.000+01:00"));
    expect(startMs).toBeGreaterThan(Date.now());
  });

  it("still answers for a date beyond the 60 day public booking horizon, which the agent may exceed", async () => {
    // 76 days out, and on GMT rather than BST: both the horizon and the offset.
    const FAR = "2026-11-05";
    const dentally = strictDentally([windowOn(FAR, "09:00", "10:00", "+00:00")]);
    const { slots } = await findSlots(dentally, { treatment: "hygiene", fromDate: FAR, toDate: FAR });

    expect(slots).toHaveLength(2);
    expect(slots.every((s) => londonDay(s.start_time) === FAR)).toBe(true);
  });
});

describe("find_slots offers only the days the patient asked about", () => {
  it("does not leak the day after into a tomorrow-only answer, though the window had to reach into it", async () => {
    const dentally = strictDentally([
      windowOn(TOMORROW, "09:00", "10:00"),
      windowOn(DAY_AFTER, "09:00", "10:00"), // inside the widened window, outside the question
    ]);
    const { slots } = await findSlots(dentally, { treatment: "hygiene", fromDate: TOMORROW, toDate: TOMORROW });

    expect(slots).toHaveLength(2); // the two half hours of tomorrow's window, and nothing else
    expect(slots.every((s) => londonDay(s.start_time) === TOMORROW)).toBe(true);
    // The window really was widened past the requested day: that is what makes the
    // trim necessary rather than decorative.
    expect(Date.parse(dentally.sent[0]!.finishTime)).toBeGreaterThan(
      Date.parse(`${TOMORROW}T23:59:59.999+01:00`),
    );
  });

  it("decides the clinician preference on the requested day alone, not on rows nobody asked for", async () => {
    // The invited clinician is free the day AFTER the one the patient asked about,
    // and another clinician is free on the day itself. Deciding the soft preference
    // before the trim reads p1 as "has availability", offers only p1's rows, and the
    // day trim then empties the answer: the patient is told nothing is free tomorrow
    // while p2's diary sits open. So the trim happens on the ROWS, first.
    const dentally = strictDentally([
      windowOn(DAY_AFTER, "09:00", "10:00", "+01:00", "p1"),
      windowOn(TOMORROW, "09:00", "10:00", "+01:00", "p2"),
    ]);
    const dispatch = makeDispatch({
      dentally,
      context: {
        ...context(),
        outreachInvite: { treatmentAngle: "hygiene clean", practitionerName: "Dr P1", practitionerId: "p1" },
      },
      writesEnabled: true,
    } as never);
    const { slots } = JSON.parse(
      await dispatch("find_slots", { treatment: "hygiene", fromDate: TOMORROW, toDate: TOMORROW }),
    ) as { slots: Array<{ start_time: string; practitioner_id?: string }> };

    expect(slots).toHaveLength(2);
    expect(slots.every((s) => s.practitioner_id === "p2")).toBe(true);
  });

  it("keeps only the requested day's half of a window running through London midnight", async () => {
    // Chunking is the one thing that can still put a slot on the wrong day: this row
    // starts inside the requested day, so the row itself is rightly kept.
    const dentally = strictDentally([
      { start_time: `${TOMORROW}T23:00:00.000+01:00`, finish_time: `${DAY_AFTER}T01:00:00.000+01:00`, practitioner_id: "p1" },
    ]);
    const { slots } = await findSlots(dentally, { treatment: "hygiene", fromDate: TOMORROW, toDate: TOMORROW });

    expect(slots).toHaveLength(2); // 23:00 and 23:30; midnight onwards belongs to the next day
    expect(slots.every((s) => londonDay(s.start_time) === TOMORROW)).toBe(true);
  });

  it("leaves an open-ended search alone: with no end date nothing was widened past the range", async () => {
    // The model names no toDate, so the range IS this tool's own fourteen day
    // search. Everything Dentally answers with belongs to it.
    const dentally = strictDentally([windowOn(TOMORROW, "09:00", "10:00"), windowOn(DAY_AFTER, "09:00", "10:00")]);
    const { slots } = await findSlots(dentally, { treatment: "hygiene" });

    expect(slots).toHaveLength(4);
    // And the search really does run a fortnight ahead, not just past tomorrow.
    const { startTime, finishTime } = dentally.sent[0]!;
    expect(Date.parse(finishTime) - Date.parse(startTime)).toBeGreaterThan(13 * 24 * HOUR_MS);
  });
});

describe("find_slots refuses to ask about a day that has already ended", () => {
  it("makes ZERO Dentally calls for a past date", async () => {
    const dentally = strictDentally([windowOn(TODAY, "09:00", "12:00")]);
    await findSlots(dentally, { treatment: "hygiene", fromDate: "2026-08-19", toDate: "2026-08-19" });

    // Not the availability read, and not even the practitioner list: Dentally can
    // never answer for a past day, so the only product of asking would be a 400
    // against the practice's shared rate budget.
    expect(dentally.getAvailability).not.toHaveBeenCalled();
    expect(dentally.listPractitioners).not.toHaveBeenCalled();
  });

  it("tells the model the date has passed, in words it can repeat, instead of an empty list", async () => {
    const dentally = strictDentally([]);
    const out = await findSlots(dentally, { treatment: "hygiene", fromDate: "2026-08-19", toDate: "2026-08-19" });

    expect(out.slots).toEqual([]);
    // An empty list alone reads as "the practice is fully booked", which is a lie
    // about a day that is simply in the past.
    expect(out.error).toMatch(/passed/i);
    expect(out.error).toMatch(/find_slots again/);
    // Project rule: nothing the agent says may name a funding regime.
    expect(out.error).not.toMatch(/\b(NHS|private)\b/i);
  });

  it("still searches forward when only the START date has passed, since the range has not", async () => {
    const dentally = strictDentally([windowOn(TOMORROW, "09:00", "10:00")]);
    const { slots } = await findSlots(dentally, { treatment: "hygiene", fromDate: "2026-08-19", toDate: TOMORROW });

    expect(dentally.getAvailability).toHaveBeenCalledTimes(1);
    expect(Date.parse(dentally.sent[0]!.startTime)).toBeGreaterThan(Date.now());
    expect(slots).toHaveLength(2);
  });
});

// A model that says the days in the wrong order is not a model that means an
// empty range. "Anything between the 5th and the 10th?" comes back as
// fromDate="2026-09-10", toDate="2026-09-05" often enough, and before
// orderedDayPair that pair asked Dentally a perfectly good question about the
// 10th and then discarded every row it answered with — each one started after the
// end of the 5th — leaving {slots: []} with no error for the agent to relay. The
// patient was told nothing was free on days the practice was open.
describe("find_slots reads a reversed date pair the way the patient meant it", () => {
  const EARLIER = "2026-09-05";
  const LATER = "2026-09-10";

  it("answers a reversed pair with EXACTLY the slots the ordered pair returns", async () => {
    const rows = () => [
      windowOn(EARLIER, "09:00", "11:00", "+01:00", "p1"),
      windowOn("2026-09-07", "14:00", "15:00", "+01:00", "p2"),
      windowOn(LATER, "09:00", "10:00", "+01:00", "p1"),
    ];
    const ordered = await findSlots(strictDentally(rows()), {
      treatment: "hygiene",
      fromDate: EARLIER,
      toDate: LATER,
    });
    const reversed = await findSlots(strictDentally(rows()), {
      treatment: "hygiene",
      fromDate: LATER,
      toDate: EARLIER,
    });

    expect(ordered.slots.length).toBeGreaterThan(0); // the comparison must have teeth
    expect(reversed.slots).toEqual(ordered.slots); // and not two empty lists
    expect(reversed.error).toBeUndefined();
  });

  it("sends the SAME window for a reversed pair, so the swap happens before the request", async () => {
    const ordered = strictDentally([windowOn(EARLIER, "09:00", "11:00")]);
    await findSlots(ordered, { treatment: "hygiene", fromDate: EARLIER, toDate: LATER });
    const reversed = strictDentally([windowOn(EARLIER, "09:00", "11:00")]);
    await findSlots(reversed, { treatment: "hygiene", fromDate: LATER, toDate: EARLIER });

    // The window is built off the FROM day: a reversed pair left alone would have
    // started on the 10th and never asked about the 5th at all.
    expect(reversed.sent).toEqual(ordered.sent);
    expect(Date.parse(reversed.sent[0]!.startTime)).toBe(Date.parse(`${EARLIER}T00:00:00.000+01:00`));
  });

  it("still trims a reversed pair to the days asked about, rather than trimming nothing", async () => {
    // Swapping must not turn the trim off: the widened window reaches past the
    // 10th, and the day after is still a day nobody asked about.
    const dentally = strictDentally([
      windowOn(LATER, "09:00", "10:00"),
      windowOn("2026-09-11", "09:00", "10:00"),
    ]);
    const { slots } = await findSlots(dentally, { treatment: "hygiene", fromDate: LATER, toDate: EARLIER });

    expect(slots).toHaveLength(2);
    expect(slots.every((s) => londonDay(s.start_time) === LATER)).toBe(true);
  });

  it("still refuses, with ZERO Dentally calls, when a reversed pair is entirely in the past", async () => {
    // Ordering the pair must not smuggle a past range back into a live question:
    // both days ended before the frozen now, so there is nothing to ask about and
    // the model is told so in words rather than handed an empty list.
    const dentally = strictDentally([windowOn(TODAY, "09:00", "12:00")]);
    const out = await findSlots(dentally, { treatment: "hygiene", fromDate: "2026-08-19", toDate: "2026-08-17" });

    expect(dentally.getAvailability).not.toHaveBeenCalled();
    expect(dentally.listPractitioners).not.toHaveBeenCalled();
    expect(out.slots).toEqual([]);
    expect(out.error).toMatch(/passed/i);
  });
});
