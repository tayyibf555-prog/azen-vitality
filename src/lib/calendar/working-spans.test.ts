import { describe, expect, it } from "vitest";
import type { AvailabilityWindow } from "./availability";
import { columnWorkState, mergeSpans, offSpans, workingSpans, type Span } from "./working-spans";

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
