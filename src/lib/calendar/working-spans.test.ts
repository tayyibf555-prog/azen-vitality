import { describe, expect, it } from "vitest";
import type { AvailabilityWindow } from "./availability";
import {
  columnIsHatched,
  columnWorkState,
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

describe("columnIsHatched", () => {
  it("hatches every state that is not a claim about the clinician", () => {
    expect(columnIsHatched("unknown")).toBe(true);
    expect(columnIsHatched("unconfirmed")).toBe(true);
    // The one this file exists to stop being forgotten: a state added to the
    // union and not to the paint rule renders GREY, which is a positive claim
    // that somebody was off, made by an omission.
    expect(columnIsHatched("past")).toBe(true);
  });

  it("does NOT hatch the two states we can stand behind", () => {
    expect(columnIsHatched("working")).toBe(false);
    expect(columnIsHatched("off")).toBe(false);
  });

  it("covers every member of ColumnWorkState, so a new one cannot slip past", () => {
    const all: ColumnWorkState[] = ["working", "off", "unknown", "unconfirmed", "past"];
    expect(all.filter(columnIsHatched)).toEqual(["unknown", "unconfirmed", "past"]);
  });
});
