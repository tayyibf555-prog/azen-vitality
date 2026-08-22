import { describe, expect, it } from "vitest";
import type { AvailabilityWindow } from "./availability";
import {
  COLUMN_WORK_PRESENTATION,
  columnIsHatched,
  columnWorkState,
  columnWorkSummary,
  mergeSpans,
  offSpans,
  workingSpans,
  type ColumnWorkState,
  type Span,
} from "./working-spans";

const w = (startMin: number, endMin: number, practitionerId = "p"): AvailabilityWindow => ({
  practitionerId,
  dayKey: "2026-07-31",
  startMin,
  endMin,
});
const s = (startMin: number, endMin: number): Span => ({ startMin, endMin });

describe("mergeSpans", () => {
  it("sorts, merges overlaps and joins touching spans", () => {
    expect(mergeSpans([s(600, 660), s(540, 600), s(700, 720)])).toEqual([s(540, 660), s(700, 720)]);
    expect(mergeSpans([s(540, 700), s(600, 660)])).toEqual([s(540, 700)]);
  });

  it("drops zero-length and reversed spans", () => {
    expect(mergeSpans([s(600, 600), s(700, 650)])).toEqual([]);
  });

  it("does not mutate its input", () => {
    const input = [s(540, 600), s(600, 660)];
    mergeSpans(input);
    expect(input).toEqual([s(540, 600), s(600, 660)]);
  });
});

describe("workingSpans", () => {
  it("is the merged union of availability windows and booked spans", () => {
    expect(workingSpans([w(540, 720)], [s(700, 780)])).toEqual([s(540, 780)]);
  });

  it("gives white to an appointment lying wholly OUTSIDE every window", () => {
    // A booking is proof of a session even when availability says nothing about it.
    expect(workingSpans([w(540, 660)], [s(1080, 1140)])).toEqual([s(540, 660), s(1080, 1140)]);
  });

  it("counts a cancelled and a did-not-attend appointment as working time", () => {
    // The caller passes every state's span: the clinician was in the building
    // either way, so the session was real. Occupancy for a DROP is a different
    // question, answered in move-validate.
    expect(workingSpans([], [s(600, 630), s(660, 690)])).toEqual([s(600, 630), s(660, 690)]);
  });

  it("is empty when there is neither a window nor a booking", () => {
    expect(workingSpans([], [])).toEqual([]);
  });
});

describe("columnWorkState", () => {
  const base = { availabilityFailed: false, appointmentsFailed: false, windows: [w(540, 1020)], apptSpans: [] };

  it("is 'unknown' when EITHER read failed, never 'off'", () => {
    expect(columnWorkState({ ...base, availabilityFailed: true })).toBe("unknown");
    expect(columnWorkState({ ...base, appointmentsFailed: true })).toBe("unknown");
    // Even with zero windows: a failed read must never paint grey.
    expect(columnWorkState({ availabilityFailed: true, appointmentsFailed: false, windows: [], apptSpans: [] })).toBe(
      "unknown",
    );
  });

  it("is 'off' for zero windows and zero appointments with both reads good", () => {
    expect(
      columnWorkState({ availabilityFailed: false, appointmentsFailed: false, windows: [], apptSpans: [] }),
    ).toBe("off");
  });

  it("is 'working' when either source says so", () => {
    expect(columnWorkState(base)).toBe("working");
    expect(
      columnWorkState({ availabilityFailed: false, appointmentsFailed: false, windows: [], apptSpans: [s(600, 630)] }),
    ).toBe("working");
  });
});

describe("offSpans", () => {
  it("is the exact complement inside bounds", () => {
    expect(offSpans([s(540, 720), s(780, 1020)], s(480, 1080))).toEqual([
      s(480, 540),
      s(720, 780),
      s(1020, 1080),
    ]);
  });

  it("is the whole of bounds when nothing is working", () => {
    expect(offSpans([], s(480, 1080))).toEqual([s(480, 1080)]);
  });

  it("is empty when working covers the whole of bounds", () => {
    expect(offSpans([s(400, 1200)], s(480, 1080))).toEqual([]);
  });

  it("clips working time that overhangs bounds", () => {
    expect(offSpans([s(400, 600)], s(480, 1080))).toEqual([s(600, 1080)]);
  });

  it("is empty for empty bounds", () => {
    expect(offSpans([s(540, 720)], s(600, 600))).toEqual([]);
  });
});

describe("columnWorkState and the cross-site fourth state", () => {
  const base = { availabilityFailed: false, appointmentsFailed: false, windows: [w(540, 1020)], apptSpans: [] };

  it("is 'unconfirmed' when the clinician cannot be placed at this practice", () => {
    // NOT 'off'. They may well be working, at another of these practices, and
    // their availability carries no site to tell us which.
    expect(columnWorkState({ ...base, presenceConfirmed: false })).toBe("unconfirmed");
  });

  it("still prefers 'unknown' when a read failed, because that is the more fundamental gap", () => {
    expect(
      columnWorkState({ ...base, availabilityFailed: true, presenceConfirmed: false }),
    ).toBe("unknown");
  });

  it("is unchanged for callers that have no cross-site picture at all", () => {
    expect(columnWorkState(base)).toBe("working");
    expect(columnWorkState({ ...base, presenceConfirmed: true })).toBe("working");
  });

  it("is 'unconfirmed' even with windows in hand, since those windows are the doubt", () => {
    expect(
      columnWorkState({ ...base, windows: [w(540, 1020)], presenceConfirmed: false }),
    ).toBe("unconfirmed");
  });
});

describe("columnWorkState and the day that has already gone", () => {
  const base = { availabilityFailed: false, appointmentsFailed: false, windows: [], apptSpans: [] };

  it("is 'past', not 'off', when Dentally could not be asked about the day", () => {
    // Dentally refuses every availability window that is not in the future, so a
    // day that has ended is UNASKABLE. Grey would claim the practice was shut on
    // a day we never got to ask about.
    expect(columnWorkState({ ...base, availabilityUnanswerable: true })).toBe("past");
  });

  it("is 'past' even when the day's own bookings prove somebody was in", () => {
    // The bookings still draw, but the HOURS are not a claim this column can make:
    // a booking proves 10:00-10:30, never that the session ran 09:00-17:00.
    expect(
      columnWorkState({ ...base, apptSpans: [s(600, 630)], availabilityUnanswerable: true }),
    ).toBe("past");
  });

  it("still prefers 'unknown' when a read FAILED on a past day", () => {
    // An outage we do not understand must not be explained away by the calendar.
    expect(
      columnWorkState({ ...base, availabilityFailed: true, availabilityUnanswerable: true }),
    ).toBe("unknown");
    expect(
      columnWorkState({ ...base, appointmentsFailed: true, availabilityUnanswerable: true }),
    ).toBe("unknown");
  });

  it("is unchanged for every caller that does not pass the flag", () => {
    expect(columnWorkState({ ...base, windows: [w(540, 1020)] })).toBe("working");
    expect(columnWorkState(base)).toBe("off");
    expect(columnWorkState({ ...base, availabilityUnanswerable: false })).toBe("off");
  });
});

// ===========================================================================
// THE MORNING NOBODY COULD ASK ABOUT.
//
// THE LIVE BUG THIS EXISTS TO STOP COMING BACK. Dentally answers availability
// only from a start time in the future, so the diary's request for TODAY is
// clamped to now+2min -- and a window that had already CLOSED by then is simply
// not in the answer. A clinician rostered 09:00-13:00 with nothing booked
// therefore returned NOTHING from lunchtime onwards, every single day, and an
// empty answer collapsed to "off": the column printed "Not working" over
// somebody who had been in all morning. A receptionist reading that column stops
// offering their next available slot, and nobody ever finds out why.
// ===========================================================================
describe("columnWorkState and the part of today nobody could ask about", () => {
  const AFTERNOON = 15 * 60 + 2; // the clamped start, 15:02 London
  const base = { availabilityFailed: false, appointmentsFailed: false, windows: [], apptSpans: [] };

  it("is 'unreportable', NOT 'off', for a morning clinician viewed in the afternoon", () => {
    // Zero windows and zero bookings, at 15:02, for somebody whose only session
    // ended at 13:00. The answer is empty because the question could not be put.
    expect(columnWorkState({ ...base, answerableFromMin: AFTERNOON })).toBe("unreportable");
  });

  it("is rescued to 'working' by a single booked appointment that morning", () => {
    // THE UNION IS THE EVIDENCE. A booking is proof the clinician was in at that
    // time, so a day with anything booked is unaffected by all of this and reads
    // exactly as it always did.
    expect(
      columnWorkState({ ...base, apptSpans: [s(600, 630)], answerableFromMin: AFTERNOON }),
    ).toBe("working");
  });

  it("is 'working' when the afternoon session did come back", () => {
    expect(
      columnWorkState({ ...base, windows: [w(840, 1080)], answerableFromMin: AFTERNOON }),
    ).toBe("working");
  });

  it("is still 'off' when the WHOLE day was answerable and nothing came back", () => {
    // A future day is asked about from its own midnight, so silence really does
    // mean nobody is in, and grey is the honest paint. Both the default and an
    // explicit zero.
    expect(columnWorkState(base)).toBe("off");
    expect(columnWorkState({ ...base, answerableFromMin: 0 })).toBe("off");
  });

  it("still prefers 'past' when the day had ended entirely", () => {
    // "Date has passed" is the right sentence about last Monday. This one is
    // about TODAY, and the two must not be told with the same words.
    expect(
      columnWorkState({ ...base, availabilityUnanswerable: true, answerableFromMin: AFTERNOON }),
    ).toBe("past");
  });

  it("still prefers 'unknown' when a read FAILED", () => {
    // An outage we do not understand must not be explained away by the clock.
    expect(
      columnWorkState({ ...base, availabilityFailed: true, answerableFromMin: AFTERNOON }),
    ).toBe("unknown");
    expect(
      columnWorkState({ ...base, appointmentsFailed: true, answerableFromMin: AFTERNOON }),
    ).toBe("unknown");
  });

  it("still prefers 'unconfirmed' when the clinician cannot be placed at this practice", () => {
    expect(
      columnWorkState({ ...base, presenceConfirmed: false, answerableFromMin: AFTERNOON }),
    ).toBe("unconfirmed");
  });

  it("is unchanged for every caller that does not pass the minute at all", () => {
    expect(columnWorkState({ ...base, windows: [w(540, 1020)] })).toBe("working");
    expect(columnWorkState(base)).toBe("off");
  });
});

/** The union itself, at runtime: every key the Record type forces to exist. */
const ALL_WORK_STATES = Object.keys(COLUMN_WORK_PRESENTATION) as ColumnWorkState[];

describe("columnIsHatched", () => {
  it("hatches every state that is not a claim about the clinician", () => {
    expect(columnIsHatched("unknown")).toBe(true);
    expect(columnIsHatched("unconfirmed")).toBe(true);
    // The one this file exists to stop being forgotten: a state added to the
    // union and not to the paint rule renders GREY, which is a positive claim
    // that somebody was off, made by an omission.
    expect(columnIsHatched("past")).toBe(true);
    expect(columnIsHatched("unreportable")).toBe(true);
  });

  it("does NOT hatch the two states we can stand behind", () => {
    expect(columnIsHatched("working")).toBe(false);
    expect(columnIsHatched("off")).toBe(false);
  });

  it("covers every member of ColumnWorkState, so a new one cannot slip past", () => {
    // DERIVED FROM THE MAPPING, not hand-written. This test used to list the six
    // members in an array of its own, and the sentence in its name was therefore
    // a promise it could not keep: the compiler never checked that array against
    // the union, so a seventh member could be added and this test stayed green
    // while the or-chain it was guarding quietly painted the new state grey.
    // Object.keys of a Record<ColumnWorkState, ...> IS the union, and the Record
    // is the thing both grids read.
    const all = ALL_WORK_STATES;
    expect(all.filter(columnIsHatched)).toEqual([
      "unknown",
      "unconfirmed",
      "past",
      "unreportable",
    ]);
  });
});


describe("COLUMN_WORK_PRESENTATION, the one mapping both grids read", () => {
  it("has a row for every member of the union, and nothing else", () => {
    // The compiler is the real guard -- a missing state does not typecheck -- so
    // this only pins the count a reader of the header is entitled to assume.
    expect([...ALL_WORK_STATES].sort()).toEqual([
      "off",
      "past",
      "unconfirmed",
      "unknown",
      "unreportable",
      "working",
    ]);
  });

  it("gives every state that cannot claim a number a sentence of its own", () => {
    for (const state of ALL_WORK_STATES) {
      const shown = COLUMN_WORK_PRESENTATION[state];
      if (state === "working") continue;
      expect(shown.label, `"${state}" has no words`).toBeTruthy();
    }
  });

  it("prints the counts for exactly ONE state: the one we can stand behind", () => {
    // A null label means the column prints its appointment counts. Any state but
    // "working" doing that is a confident number about a day we could not read.
    expect(ALL_WORK_STATES.filter((s) => COLUMN_WORK_PRESENTATION[s].label === null)).toEqual([
      "working",
    ]);
  });

  it("never lets two states say the same thing, which is how six collapse into four", () => {
    const said = ALL_WORK_STATES.flatMap((s) => [
      COLUMN_WORK_PRESENTATION[s].label,
      COLUMN_WORK_PRESENTATION[s].pendingLabel,
    ]).filter((w): w is string => typeof w === "string");
    expect(new Set(said).size, `duplicated wording: ${said.join(" | ")}`).toBe(said.length);
  });
});

describe("columnWorkSummary", () => {
  it("says exactly what the two grids used to say for themselves", () => {
    expect(columnWorkSummary("working")).toBeNull();
    expect(columnWorkSummary("off")).toBe("Not working");
    expect(columnWorkSummary("unknown")).toBe("Hours not loaded");
    expect(columnWorkSummary("unconfirmed")).toBe("Not confirmed here");
    expect(columnWorkSummary("past")).toBe("Date has passed");
    expect(columnWorkSummary("unreportable")).toBe("Hours not reportable");
  });

  it("changes the WORDS for a read in flight, and only for 'unknown'", () => {
    expect(columnWorkSummary("unknown", { hoursPending: true })).toBe("Reading hours");
    // Nothing else moves: a pending read says nothing about a date that has gone
    // by, or about a clinician we cannot place at this practice.
    for (const state of ALL_WORK_STATES) {
      if (state === "unknown") continue;
      expect(columnWorkSummary(state, { hoursPending: true })).toBe(columnWorkSummary(state));
    }
  });

  it("does not change the TEXTURE for a read in flight", () => {
    // Different words, same hatch: we still have no answer, and grey would claim
    // the clinician was off while the question was still being asked.
    expect(columnIsHatched("unknown")).toBe(true);
  });
});
