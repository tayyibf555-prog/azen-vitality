import { describe, expect, it } from "vitest";
import { formatDay, formatDayRange, numberNotes, splitNotes } from "@/lib/home-variants/a/notes";

describe("numberNotes", () => {
  it("numbers from one, in order", () => {
    expect(numberNotes(["first", "second"])).toEqual([
      { n: 1, text: "first" },
      { n: 2, text: "second" },
    ]);
  });

  it("drops blanks without leaving a gap in the numbering", () => {
    expect(numberNotes(["a", "   ", null, undefined, "b"])).toEqual([
      { n: 1, text: "a" },
      { n: 2, text: "b" },
    ]);
  });

  it("keeps the sentence verbatim apart from surrounding space", () => {
    const long = "12 payment records could not be read and are counted in no total.";
    expect(numberNotes([` ${long} `])[0].text).toBe(long);
  });
});

describe("splitNotes", () => {
  it("attaches what qualifies a figure and backgrounds what only explains", () => {
    const split = splitNotes([
      { text: "Today and yesterday are read live.", material: false },
      { text: "3 payments carry no site.", material: true },
    ]);
    expect(split.attached).toEqual([{ n: 1, text: "3 payments carry no site." }]);
    expect(split.background).toEqual(["Today and yesterday are read live."]);
  });

  it("never drops a material caveat", () => {
    const split = splitNotes([
      { text: "one", material: true },
      { text: "two", material: true },
      { text: "three", material: true },
    ]);
    expect(split.attached.map((n) => n.text)).toEqual(["one", "two", "three"]);
    expect(split.background).toEqual([]);
  });

  it("de-duplicates identical background sentences", () => {
    const split = splitNotes([
      { text: "A balance is what is owed today.", material: false },
      { text: "A balance is what is owed today.", material: false },
    ]);
    expect(split.background).toEqual(["A balance is what is owed today."]);
  });

  it("returns two empty tiers for no caveats", () => {
    expect(splitNotes([])).toEqual({ attached: [], background: [] });
  });
});

describe("formatDay", () => {
  it("sets a day key British style", () => {
    expect(formatDay("2026-07-31")).toBe("31 Jul 2026");
    expect(formatDay("2026-01-01")).toBe("1 Jan 2026");
    expect(formatDay("2026-12-09")).toBe("9 Dec 2026");
  });

  it("does not shift the day, whatever the host time zone is", () => {
    // The key IS the London calendar day. Parsing it as an instant and
    // formatting it back is what prints 31 July as 30 July west of UTC.
    expect(formatDay("2026-07-01")).toBe("1 Jul 2026");
  });

  it("returns anything that is not a day key unchanged", () => {
    expect(formatDay("")).toBe("");
    expect(formatDay("31/07/2026")).toBe("31/07/2026");
    expect(formatDay("2026-13-01")).toBe("2026-13-01");
  });
});

describe("formatDayRange", () => {
  it("prints one day once", () => {
    expect(formatDayRange("2026-07-31", "2026-07-31")).toBe("31 Jul 2026");
  });

  it("prints the month and year once inside a month", () => {
    expect(formatDayRange("2026-07-01", "2026-07-31")).toBe("1 to 31 Jul 2026");
  });

  it("prints the year once inside a year", () => {
    expect(formatDayRange("2026-05-03", "2026-07-31")).toBe("3 May to 31 Jul 2026");
  });

  it("prints both in full across a year boundary", () => {
    expect(formatDayRange("2025-11-02", "2026-01-30")).toBe("2 Nov 2025 to 30 Jan 2026");
  });

  it("falls back to the raw keys when one is unreadable", () => {
    expect(formatDayRange("nonsense", "2026-07-31")).toBe("nonsense to 31 Jul 2026");
  });
});
