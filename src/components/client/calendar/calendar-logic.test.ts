import { describe, it, expect } from "vitest";
import {
  dayKey,
  shiftDay,
  mondayOf,
  clampDayToWindow,
  isWithinWindow,
  hhmm,
  longDate,
  weekLabel,
  dow,
  dnum,
  stateDotClass,
  stateLabel,
  STATE_BADGE_TONE,
  STATE_BADGE_LABEL,
} from "./calendar-logic";

describe("dayKey (B2: London-day bucketing, not a UTC slice)", () => {
  it("buckets a late-evening BST appointment onto the NEXT London day", () => {
    // 23:30Z in summer (BST = UTC+1) is 00:30 the next morning in London. A raw
    // UTC slice of the ISO string would wrongly bucket this onto the 27th.
    expect(dayKey("2026-06-27T23:30:00Z")).toBe("2026-06-28");
  });

  it("keeps a winter (GMT) appointment on the same day either way", () => {
    expect(dayKey("2026-01-15T09:00:00Z")).toBe("2026-01-15");
  });

  it("keeps a summer midday appointment on the same day", () => {
    expect(dayKey("2026-06-27T12:00:00Z")).toBe("2026-06-27");
  });
});

describe("hhmm (B1: London wall-clock time, never UTC)", () => {
  it("shows the London time in BST, one hour ahead of the raw UTC instant", () => {
    // 08:00Z in summer is 09:00 in London. The old bug rendered this as 08:00.
    expect(hhmm("2026-06-27T08:00:00Z")).toBe("09:00");
  });

  it("matches UTC in winter (GMT = UTC+0)", () => {
    expect(hhmm("2026-01-15T08:00:00Z")).toBe("08:00");
  });
});

describe("shiftDay / mondayOf", () => {
  it("steps a day key forward and backward", () => {
    expect(shiftDay("2026-06-27", 1)).toBe("2026-06-28");
    expect(shiftDay("2026-06-27", -1)).toBe("2026-06-26");
    expect(shiftDay("2026-06-27", 7)).toBe("2026-07-04");
  });

  it("finds the Monday of the containing week", () => {
    expect(mondayOf("2026-07-01")).toBe("2026-06-29"); // Wednesday -> that Monday
    expect(mondayOf("2026-06-29")).toBe("2026-06-29"); // Monday -> itself
  });
});

describe("clampDayToWindow / isWithinWindow (B4: never navigate past loaded data)", () => {
  const min = "2026-06-01";
  const max = "2026-07-30";

  it("passes a day already inside the window through unchanged", () => {
    expect(clampDayToWindow("2026-06-15", min, max)).toBe("2026-06-15");
  });

  it("clamps a day before the window up to the earliest loaded day", () => {
    expect(clampDayToWindow("2026-05-20", min, max)).toBe(min);
  });

  it("clamps a day after the window down to the latest loaded day", () => {
    expect(clampDayToWindow("2026-08-10", min, max)).toBe(max);
  });

  it("reports whether a day is within the window, inclusive of both ends", () => {
    expect(isWithinWindow(min, min, max)).toBe(true);
    expect(isWithinWindow(max, min, max)).toBe(true);
    expect(isWithinWindow("2026-05-31", min, max)).toBe(false);
    expect(isWithinWindow("2026-07-31", min, max)).toBe(false);
  });
});

describe("longDate / weekLabel / dow / dnum", () => {
  it("formats a long date", () => {
    expect(longDate("2026-07-02")).toBe("Thursday, 2 July 2026");
  });

  it("formats a week label spanning Monday to Sunday", () => {
    expect(weekLabel("2026-07-02")).toBe("29 Jun, 5 Jul 2026");
  });

  it("formats the short day-of-week and the day number", () => {
    expect(dow("2026-07-02")).toBe("Thu");
    expect(dnum("2026-07-02")).toBe(2);
  });
});

describe("stateDotClass / stateLabel (B5: every state visually distinct)", () => {
  it("gives confirmed, arrived and in_surgery each a DIFFERENT colour from cancelled", () => {
    const cancelled = stateDotClass("cancelled");
    expect(stateDotClass("confirmed")).not.toBe(cancelled);
    expect(stateDotClass("arrived")).not.toBe(cancelled);
    expect(stateDotClass("in_surgery")).not.toBe(cancelled);
  });

  it("gives confirmed, arrived and in_surgery each a DIFFERENT colour from one another", () => {
    const colours = [stateDotClass("confirmed"), stateDotClass("arrived"), stateDotClass("in_surgery")];
    expect(new Set(colours).size).toBe(3);
  });

  it("keeps did_not_attend red and cancelled grey (unchanged prior behaviour)", () => {
    expect(stateDotClass("did_not_attend")).toBe("bg-status-red");
    expect(stateDotClass("cancelled")).toBe("bg-line-strong");
  });

  it("falls back to the neutral grey for an unrecognised state", () => {
    expect(stateDotClass("some_new_state")).toBe("bg-line-strong");
  });

  it("labels every known state and falls back to the raw value otherwise", () => {
    expect(stateLabel("in_surgery")).toBe("In surgery");
    expect(stateLabel("arrived")).toBe("Arrived");
    expect(stateLabel("mystery")).toBe("mystery");
  });
});

describe("STATE_BADGE_TONE / STATE_BADGE_LABEL", () => {
  it("calls out the actionable states with a badge", () => {
    expect(STATE_BADGE_TONE.pending).toBe("warning");
    expect(STATE_BADGE_TONE.arrived).toBe("info");
    expect(STATE_BADGE_TONE.in_surgery).toBe("info");
    expect(STATE_BADGE_TONE.did_not_attend).toBe("danger");
    expect(STATE_BADGE_LABEL.arrived).toBe("Arrived");
  });

  it("leaves the routine progression (booked/confirmed/completed) and cancelled without a badge", () => {
    expect(STATE_BADGE_TONE.booked).toBeUndefined();
    expect(STATE_BADGE_TONE.confirmed).toBeUndefined();
    expect(STATE_BADGE_TONE.completed).toBeUndefined();
    expect(STATE_BADGE_TONE.cancelled).toBeUndefined();
  });
});
