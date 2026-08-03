import { describe, expect, it } from "vitest";
import {
  MIN_USEFUL_PIECE_MIN,
  capacityLine,
  capacitySentence,
  columnCapacity,
  shortDuration,
} from "./capacity";

const BOUNDS = { startMin: 480, endMin: 1200 }; // 08:00 to 20:00

/** 09:00 to 17:00, the shape most of these use. */
const NINE_TO_FIVE = [{ startMin: 540, endMin: 1020 }];

function cap(over: Partial<Parameters<typeof columnCapacity>[0]> = {}) {
  return columnCapacity({
    working: NINE_TO_FIVE,
    occupied: [],
    breaks: [],
    bounds: BOUNDS,
    ...over,
  });
}

describe("columnCapacity: the arithmetic", () => {
  it("counts an empty working day as entirely free", () => {
    const c = cap();
    expect(c.workingMin).toBe(480);
    expect(c.bookedMin).toBe(0);
    expect(c.freeMin).toBe(480);
    expect(c.longestFreeMin).toBe(480);
    expect(c.longestStartMin).toBe(540);
  });

  it("subtracts appointments and breaks alike", () => {
    const c = cap({
      occupied: [{ startMin: 540, endMin: 600 }],
      breaks: [{ startMin: 780, endMin: 840 }],
    });
    expect(c.bookedMin).toBe(120);
    expect(c.freeMin).toBe(360);
  });

  it("always has workingMin = bookedMin + freeMin", () => {
    const c = cap({
      occupied: [
        { startMin: 540, endMin: 615 },
        { startMin: 700, endMin: 730 },
      ],
      breaks: [{ startMin: 780, endMin: 825 }],
    });
    expect(c.bookedMin + c.freeMin).toBe(c.workingMin);
  });

  it("counts a DOUBLE booking as one hour consumed, never two", () => {
    // Two clinicians' worth of patients on one clinician is a real state this
    // diary draws as two lanes. It is still only one hour of that person's day.
    const c = cap({
      occupied: [
        { startMin: 600, endMin: 660 },
        { startMin: 600, endMin: 660 },
      ],
    });
    expect(c.bookedMin).toBe(60);
    expect(c.freeMin).toBe(420);
  });

  it("counts overlapping-but-not-identical bookings as their union", () => {
    const c = cap({
      occupied: [
        { startMin: 600, endMin: 660 },
        { startMin: 630, endMin: 720 },
      ],
    });
    expect(c.bookedMin).toBe(120); // 10:00 to 12:00
  });

  it("does not let a booking running past the end of a session overstate what was consumed", () => {
    // A 16:30 appointment recorded as three hours long. Only the half hour
    // inside the session can be consumed; the rest is not working time at all.
    const c = cap({ occupied: [{ startMin: 990, endMin: 1170 }] });
    expect(c.workingMin).toBe(480);
    expect(c.bookedMin).toBe(30);
    expect(c.freeMin).toBe(450);
  });

  it("clips everything to the drawn day, so a booking outside it changes nothing", () => {
    const c = columnCapacity({
      working: [{ startMin: 300, endMin: 1400 }],
      occupied: [{ startMin: 300, endMin: 400 }],
      breaks: [],
      bounds: BOUNDS,
    });
    expect(c.workingMin).toBe(720); // the drawn 08:00 to 20:00, not 300 to 1400
    expect(c.bookedMin).toBe(0);
  });

  it("counts two sessions separately and never the lunch between them", () => {
    const c = columnCapacity({
      working: [
        { startMin: 540, endMin: 720 },
        { startMin: 780, endMin: 1020 },
      ],
      occupied: [],
      breaks: [],
      bounds: BOUNDS,
    });
    expect(c.workingMin).toBe(420);
    expect(c.freeMin).toBe(420);
    expect(c.pieces).toHaveLength(2);
    expect(c.longestFreeMin).toBe(240);
    expect(c.longestStartMin).toBe(780);
  });
});

describe("columnCapacity: the longest run", () => {
  it("names the biggest single piece and where it starts", () => {
    const c = cap({
      occupied: [
        { startMin: 600, endMin: 630 },
        { startMin: 780, endMin: 810 },
      ],
    });
    // 09:00-10:00 (60), 10:30-13:00 (150), 13:30-17:00 (210).
    expect(c.longestFreeMin).toBe(210);
    expect(c.longestStartMin).toBe(810);
  });

  it("ignores slivers under the useful floor as PIECES but keeps them in the total", () => {
    const c = columnCapacity({
      working: [{ startMin: 540, endMin: 620 }],
      // Leaves 10 minutes at 10:00-10:10 and 60 at 09:00-10:00... arranged so the
      // only remaining hole is a 10 minute sliver.
      occupied: [
        { startMin: 540, endMin: 600 },
        { startMin: 610, endMin: 620 },
      ],
      breaks: [],
      bounds: BOUNDS,
    });
    expect(c.freeMin).toBe(10);
    expect(c.pieces).toEqual([]);
    expect(c.longestFreeMin).toBe(0);
    expect(c.longestStartMin).toBeNull();
  });

  it("keeps a piece EXACTLY at the floor", () => {
    const c = columnCapacity({
      working: [{ startMin: 540, endMin: 615 }],
      occupied: [{ startMin: 540, endMin: 600 }],
      breaks: [],
      bounds: BOUNDS,
    });
    expect(MIN_USEFUL_PIECE_MIN).toBe(15);
    expect(c.pieces).toEqual([{ startMin: 600, endMin: 615 }]);
    expect(c.longestFreeMin).toBe(15);
  });

  it("returns the pieces in TIME order, not longest first", () => {
    const c = cap({ occupied: [{ startMin: 600, endMin: 630 }] });
    expect(c.pieces.map((p) => p.startMin)).toEqual([540, 630]);
  });
});

describe("columnCapacity: nothing to say", () => {
  it("is all zeroes when the clinician has no working time at all", () => {
    const c = cap({ working: [] });
    expect(c).toEqual({
      workingMin: 0,
      bookedMin: 0,
      freeMin: 0,
      pieces: [],
      longestFreeMin: 0,
      longestStartMin: null,
    });
  });

  it("is all zeroes for an unusable bounds rather than a negative figure", () => {
    expect(cap({ bounds: { startMin: 600, endMin: 600 } }).workingMin).toBe(0);
    expect(cap({ bounds: { startMin: 900, endMin: 600 } }).workingMin).toBe(0);
    expect(cap({ bounds: { startMin: Number.NaN, endMin: 600 } }).workingMin).toBe(0);
  });

  it("never reports a negative free figure however over-booked the day is", () => {
    const c = cap({ occupied: [{ startMin: 0, endMin: 2000 }] });
    expect(c.freeMin).toBe(0);
    expect(c.bookedMin).toBe(480);
  });
});

describe("shortDuration", () => {
  it("prints the three shapes", () => {
    expect(shortDuration(45)).toBe("45m");
    expect(shortDuration(60)).toBe("1h");
    expect(shortDuration(165)).toBe("2h 45m");
  });

  it("is 0m for nothing, for negative and for unreadable", () => {
    expect(shortDuration(0)).toBe("0m");
    expect(shortDuration(-30)).toBe("0m");
    expect(shortDuration(Number.NaN)).toBe("0m");
    expect(shortDuration(Number.POSITIVE_INFINITY)).toBe("0m");
  });
});

describe("capacityLine", () => {
  it("leads with the free total and follows with the longest run and its time", () => {
    const c = cap({ occupied: [{ startMin: 540, endMin: 600 }] });
    expect(capacityLine(c)).toBe("7h free · longest 7h at 10:00");
  });

  it("says FULLY BOOKED in words rather than printing 0m free", () => {
    const c = cap({ occupied: [{ startMin: 540, endMin: 1020 }] });
    expect(capacityLine(c)).toBe("Fully booked");
  });

  it("drops the longest clause when nothing bookable is left, keeping the honest total", () => {
    const c = columnCapacity({
      working: [{ startMin: 540, endMin: 620 }],
      occupied: [
        { startMin: 540, endMin: 600 },
        { startMin: 610, endMin: 620 },
      ],
      breaks: [],
      bounds: BOUNDS,
    });
    expect(capacityLine(c)).toBe("10m free");
  });

  it("says NOTHING at all when there is no working time and when there is no capacity object", () => {
    expect(capacityLine(cap({ working: [] }))).toBeNull();
    expect(capacityLine(null)).toBeNull();
  });
});

describe("capacitySentence", () => {
  it("names the clinician and spells the figures out for a screen reader", () => {
    const c = cap({ occupied: [{ startMin: 540, endMin: 600 }] });
    const s = capacitySentence("Dana Hale", c);
    expect(s).toContain("Dana Hale");
    expect(s).toContain("7h free");
    expect(s).toContain("8h of clinical time");
    expect(s).toContain("from 10:00");
  });

  it("says fully booked, and says nothing when there is nothing to say", () => {
    expect(capacitySentence("Dana Hale", cap({ occupied: [{ startMin: 540, endMin: 1020 }] }))).toBe(
      "Dana Hale is fully booked: 8h of clinical time, none of it free.",
    );
    expect(capacitySentence("Dana Hale", cap({ working: [] }))).toBeNull();
    expect(capacitySentence("Dana Hale", null)).toBeNull();
  });
});
