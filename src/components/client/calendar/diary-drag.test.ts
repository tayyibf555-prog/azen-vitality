import { describe, it, expect } from "vitest";
import {
  clampToBounds,
  gestureFor,
  isNoopProposal,
  pointerToMinutes,
  proposeMove,
  proposeResize,
  snapDelta,
  DRAG_THRESHOLD_PX,
  RESIZE_HANDLE_MIN_BLOCK_PX,
  SNAP_MIN,
} from "./diary-drag";
import { PX_PER_5MIN } from "./diary-view";

const BOUNDS = { startMin: 8 * 60, endMin: 19 * 60 };

const ORIGIN = {
  appointmentId: "appt-1",
  dayKey: "2026-07-31",
  startMin: 9 * 60 + 30,
  endMin: 10 * 60,
  practitionerId: "prac-1",
};

describe("snapDelta", () => {
  it("rounds onto the five minute grid", () => {
    expect(snapDelta(0)).toBe(0);
    expect(snapDelta(2)).toBe(0);
    expect(snapDelta(2.6)).toBe(5);
    expect(snapDelta(7)).toBe(5);
    expect(snapDelta(-7)).toBe(-5);
    expect(snapDelta(-13)).toBe(-15);
  });

  it("treats a sub-pixel twitch as no movement at all", () => {
    expect(snapDelta(0.4)).toBe(0);
    expect(snapDelta(-0.4)).toBe(0);
  });

  it("returns zero rather than NaN for an unreadable delta", () => {
    expect(snapDelta(Number.NaN)).toBe(0);
    expect(snapDelta(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("the five minute increment", () => {
  // The whole argument for 5 rather than 15: it is a WHOLE number of pixels at
  // every zoom, so a pixel snap and a minute snap agree and cannot drift.
  it("is a whole number of pixels at every zoom", () => {
    for (const px of Object.values(PX_PER_5MIN)) {
      expect(Number.isInteger(px)).toBe(true);
      expect(Number.isInteger((SNAP_MIN / 5) * px)).toBe(true);
    }
  });
});

describe("pointerToMinutes", () => {
  it("maps the top of the body cell to the bounds start", () => {
    expect(pointerToMinutes(200, 200, 480, "normal")).toBe(480);
  });

  it("maps pixels to minutes at the zoom's own rate", () => {
    // normal is 12px per 5 minutes, so 2.4px per minute; 120px is 50 minutes.
    expect(pointerToMinutes(320, 200, 480, "normal")).toBeCloseTo(530, 6);
    // compact is 8px per 5 minutes, so 1.6px per minute; 120px is 75 minutes.
    expect(pointerToMinutes(320, 200, 480, "compact")).toBeCloseTo(555, 6);
  });
});

describe("proposeMove", () => {
  it("shifts the start by the snapped delta and preserves the length", () => {
    const p = proposeMove(ORIGIN, 47, { practitionerId: "prac-1", dayKey: "2026-07-31" }, BOUNDS);
    expect(p.startMin).toBe(9 * 60 + 30 + 45);
    expect(p.endMin - p.startMin).toBe(30);
  });

  it("snaps the DELTA, so an off-grid start stays off-grid", () => {
    const odd = { ...ORIGIN, startMin: 9 * 60 + 7, endMin: 9 * 60 + 37 };
    const p = proposeMove(odd, 5, { practitionerId: "prac-1", dayKey: "2026-07-31" }, BOUNDS);
    expect(p.startMin).toBe(9 * 60 + 12);
  });

  it("preserves an odd length exactly rather than rounding the booking", () => {
    const odd = { ...ORIGIN, startMin: 9 * 60, endMin: 9 * 60 + 37 };
    const p = proposeMove(odd, 60, { practitionerId: "prac-1", dayKey: "2026-07-31" }, BOUNDS);
    expect(p.endMin - p.startMin).toBe(37);
  });

  it("takes the clinician and the day from the target column", () => {
    const p = proposeMove(ORIGIN, 0, { practitionerId: "prac-2", dayKey: "2026-08-01" }, BOUNDS);
    expect(p.practitionerId).toBe("prac-2");
    expect(p.dayKey).toBe("2026-08-01");
    expect(p.startMin).toBe(ORIGIN.startMin);
  });

  it("carries the appointment id through untouched", () => {
    const p = proposeMove(ORIGIN, 30, { practitionerId: "prac-2", dayKey: "2026-07-31" }, BOUNDS);
    expect(p.appointmentId).toBe("appt-1");
  });

  it("a one-pixel twitch is a no-op, not a reschedule", () => {
    const p = proposeMove(ORIGIN, 0.4, { practitionerId: "prac-1", dayKey: "2026-07-31" }, BOUNDS);
    expect(isNoopProposal(p, ORIGIN)).toBe(true);
  });
});

describe("clampToBounds", () => {
  it("slides a block back inside the day without shortening it", () => {
    const p = clampToBounds(
      { appointmentId: "a", startMin: 7 * 60, endMin: 7 * 60 + 30, practitionerId: "p", dayKey: "d" },
      BOUNDS,
    );
    expect(p.startMin).toBe(BOUNDS.startMin);
    expect(p.endMin - p.startMin).toBe(30);
  });

  it("slides a block back off the bottom edge without shortening it", () => {
    const p = clampToBounds(
      { appointmentId: "a", startMin: 19 * 60, endMin: 19 * 60 + 40, practitionerId: "p", dayKey: "d" },
      BOUNDS,
    );
    expect(p.endMin).toBe(BOUNDS.endMin);
    expect(p.endMin - p.startMin).toBe(40);
  });

  it("only cuts a span that is longer than the whole drawn day", () => {
    // A two hour drawn extent and a three hour span: the one case where a move
    // cannot preserve the length, so it fills the day rather than hanging off it.
    const narrow = { startMin: 9 * 60, endMin: 11 * 60 };
    const p = clampToBounds(
      { appointmentId: "a", startMin: 8 * 60, endMin: 11 * 60, practitionerId: "p", dayKey: "d" },
      narrow,
    );
    expect(p).toMatchObject({ startMin: narrow.startMin, endMin: narrow.endMin });
  });

  it("leaves a proposal alone when the drawn extent is unusable", () => {
    const p = clampToBounds(
      { appointmentId: "a", startMin: 600, endMin: 630, practitionerId: "p", dayKey: "d" },
      { startMin: 600, endMin: 600 },
    );
    expect(p).toMatchObject({ startMin: 600, endMin: 630 });
  });

  it("a move to 07:15 is clamped, never drawn off the grid", () => {
    const p = proposeMove(ORIGIN, -(2 * 60 + 15), { practitionerId: "prac-1", dayKey: "2026-07-31" }, BOUNDS);
    expect(p.startMin).toBe(BOUNDS.startMin);
  });
});

describe("proposeResize", () => {
  it("changes the finish only", () => {
    const p = proposeResize(ORIGIN, 15, BOUNDS);
    expect(p.startMin).toBe(ORIGIN.startMin);
    expect(p.endMin).toBe(ORIGIN.endMin + 15);
    expect(p.practitionerId).toBe(ORIGIN.practitionerId);
    expect(p.dayKey).toBe(ORIGIN.dayKey);
  });

  it("never goes below five minutes", () => {
    const p = proposeResize(ORIGIN, -600, BOUNDS);
    expect(p.endMin - p.startMin).toBe(5);
  });

  it("caps at eight hours", () => {
    const wide = { startMin: 0, endMin: 1440 };
    const p = proposeResize({ ...ORIGIN, startMin: 0, endMin: 30 }, 5000, wide);
    expect(p.endMin - p.startMin).toBe(480);
  });

  it("rounds the length onto the five minute grid, because the length is what is being changed", () => {
    const odd = { ...ORIGIN, startMin: 9 * 60, endMin: 9 * 60 + 37 };
    const p = proposeResize(odd, 0, BOUNDS);
    expect((p.endMin - p.startMin) % 5).toBe(0);
    expect(p.endMin - p.startMin).toBe(35);
  });

  it("takes the largest whole five minutes that fits rather than hanging off the day", () => {
    const late = { ...ORIGIN, startMin: 18 * 60 + 50, endMin: 19 * 60 };
    const p = proposeResize(late, 120, BOUNDS);
    expect(p.endMin).toBeLessThanOrEqual(BOUNDS.endMin);
    expect((p.endMin - p.startMin) % 5).toBe(0);
  });
});

describe("the pointer path and the keyboard path", () => {
  // The proof that 'm' plus five arrow presses and a mouse drag of the same
  // distance reach the SAME dialog: they call the same function and produce a
  // deeply equal proposal. Two builders is two ways of getting a patient onto the
  // wrong clinician.
  it("produce an identical proposal for the same move", () => {
    const target = { practitionerId: "prac-2", dayKey: "2026-07-31" };
    // Pointer: 60px of travel at normal (2.4px per minute) is 25 minutes.
    const rawFromPointer =
      pointerToMinutes(360, 100, BOUNDS.startMin, "normal") -
      pointerToMinutes(300, 100, BOUNDS.startMin, "normal");
    const byPointer = proposeMove(ORIGIN, rawFromPointer, target, BOUNDS);
    // Keyboard: five presses of ArrowDown at five minutes each.
    const byKeyboard = proposeMove(ORIGIN, 5 * SNAP_MIN, target, BOUNDS);
    expect(byPointer).toEqual(byKeyboard);
  });
});

describe("gestureFor", () => {
  it("grabs the bottom strip as a resize", () => {
    expect(gestureFor(56, 60)).toBe("resize");
    expect(gestureFor(52, 60)).toBe("resize");
  });

  it("grabs the body as a move", () => {
    expect(gestureFor(10, 60)).toBe("move");
    expect(gestureFor(51, 60)).toBe("move");
  });

  it("has no resize strip at all on a block too short to draw one", () => {
    expect(gestureFor(RESIZE_HANDLE_MIN_BLOCK_PX - 2, RESIZE_HANDLE_MIN_BLOCK_PX - 1)).toBe("move");
  });
});

describe("DRAG_THRESHOLD_PX", () => {
  it("is small enough to feel immediate and large enough that a click still opens the panel", () => {
    expect(DRAG_THRESHOLD_PX).toBeGreaterThan(0);
    expect(DRAG_THRESHOLD_PX).toBeLessThanOrEqual(6);
  });
});
