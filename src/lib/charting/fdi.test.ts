import { describe, it, expect } from "vitest";
import {
  DECIDUOUS_LOWER,
  DECIDUOUS_UPPER,
  PERMANENT_LOWER,
  PERMANENT_UPPER,
  archOf,
  archRows,
  displayNumber,
  fdiLabel,
  isInArch,
  parseTeeth,
  quadrantOf,
  serialiseTeeth,
  sideOf,
  toothLabel,
  toothLongLabel,
} from "./fdi";

describe("the permanent arch", () => {
  it("reads outward from the midline in render order, viewer's left first", () => {
    expect([...PERMANENT_UPPER]).toEqual([
      18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28,
    ]);
    expect([...PERMANENT_LOWER]).toEqual([
      48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38,
    ]);
  });

  it("maps to the 8..1 | 1..8 strip Dentally prints above and below", () => {
    expect(PERMANENT_UPPER.map(displayNumber)).toEqual([
      8, 7, 6, 5, 4, 3, 2, 1, 1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(PERMANENT_LOWER.map(displayNumber)).toEqual([
      8, 7, 6, 5, 4, 3, 2, 1, 1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });

  // THE WRONG-SITE PROPERTY. The chart is drawn as the clinician faces the
  // patient, so quadrant 1 (the patient's UPPER RIGHT) sits on the viewer's
  // LEFT. Mirroring this marks the wrong side of the mouth.
  it("puts the patient's right on the viewer's left, on both arches", () => {
    expect(sideOf(18)).toBe("right");
    expect(sideOf(11)).toBe("right");
    expect(sideOf(21)).toBe("left");
    expect(sideOf(28)).toBe("left");
    expect(sideOf(48)).toBe("right");
    expect(sideOf(38)).toBe("left");
    expect(sideOf(55)).toBe("right");
    expect(sideOf(65)).toBe("left");
    expect(sideOf(85)).toBe("right");
    expect(sideOf(75)).toBe("left");
  });

  it("knows which arch each quadrant belongs to, deciduous included", () => {
    expect(archOf(16)).toBe("upper");
    expect(archOf(26)).toBe("upper");
    expect(archOf(36)).toBe("lower");
    expect(archOf(46)).toBe("lower");
    expect(archOf(55)).toBe("upper");
    expect(archOf(65)).toBe("upper");
    expect(archOf(75)).toBe("lower");
    expect(archOf(85)).toBe("lower");
  });

  it("names a tooth the way a dentist writes it, and prints its FDI number", () => {
    expect(quadrantOf(16)).toBe(1);
    expect(toothLabel(16)).toBe("UR6");
    expect(toothLabel(38)).toBe("LL8");
    expect(toothLabel(55)).toBe("UR5");
    expect(fdiLabel(16)).toBe("16");
    // The aria-label and the tooltip header must reconcile against Dentally,
    // which is why the two-digit number travels with the spoken name.
    expect(toothLongLabel(16)).toBe("upper right 6");
    expect(toothLongLabel(41)).toBe("lower right 1");
  });
});

describe("the deciduous arch", () => {
  // The primary dentition is TWENTY teeth, ten per row, five per quadrant. An
  // earlier draft of this spec said sixteen. Trimming the arrays to satisfy a
  // wrong count produces a mis-numbered deciduous chart, which is precisely the
  // wrong-site error this module exists to prevent.
  it("is twenty teeth, ten per row", () => {
    expect(DECIDUOUS_UPPER).toHaveLength(10);
    expect(DECIDUOUS_LOWER).toHaveLength(10);
    expect(DECIDUOUS_UPPER.length + DECIDUOUS_LOWER.length).toBe(20);
    expect([...DECIDUOUS_UPPER]).toEqual([55, 54, 53, 52, 51, 61, 62, 63, 64, 65]);
    expect([...DECIDUOUS_LOWER]).toEqual([85, 84, 83, 82, 81, 71, 72, 73, 74, 75]);
  });

  it("numbers 5..1 | 1..5, not 8..1 | 1..8", () => {
    expect(DECIDUOUS_UPPER.map(displayNumber)).toEqual([5, 4, 3, 2, 1, 1, 2, 3, 4, 5]);
    expect(DECIDUOUS_LOWER.map(displayNumber)).toEqual([5, 4, 3, 2, 1, 1, 2, 3, 4, 5]);
  });
});

describe("archRows", () => {
  it("draws two rows for a single dentition", () => {
    expect(archRows("permanent")).toEqual([PERMANENT_UPPER, PERMANENT_LOWER]);
    expect(archRows("deciduous")).toEqual([DECIDUOUS_UPPER, DECIDUOUS_LOWER]);
  });

  // A mixed-dentition child whose chart renders half its findings is the defect
  // this preference exists to prevent.
  it("draws all four rows for the combined chart", () => {
    expect(archRows("combined")).toHaveLength(4);
    expect(archRows("combined").flat()).toHaveLength(52);
  });

  it("draws all four rows in base-chart mode, because we cannot know which dentition a base chart concerns", () => {
    expect(archRows("base")).toHaveLength(4);
  });
});

describe("isInArch", () => {
  it("accepts only teeth the current view actually draws", () => {
    expect(isInArch(16, "permanent")).toBe(true);
    expect(isInArch(55, "permanent")).toBe(false);
    expect(isInArch(55, "deciduous")).toBe(true);
    expect(isInArch(16, "deciduous")).toBe(false);
    expect(isInArch(16, "combined")).toBe(true);
    expect(isInArch(55, "combined")).toBe(true);
    expect(isInArch(19, "combined")).toBe(false);
  });
});

describe("parseTeeth", () => {
  it("reads every wire shape Dentally might send for one tooth identically", () => {
    for (const raw of [[16], ["16"], "16", 16, " 16 "]) {
      expect(parseTeeth(raw)).toEqual({ teeth: [16], unparsed: false, absent: false });
    }
  });

  // DENTALLY.md's correction: "All teeth are stored using Palmer notation."
  // Before this the live wire format was the ONE shape parseTeeth refused, so
  // every item on every patient would have landed in unplaced and the arch
  // would have drawn 32 clean teeth while reporting health.items as "ok".
  it("converts the Palmer notation Dentally actually stores", () => {
    expect(parseTeeth("UR6")).toEqual({ teeth: [16], unparsed: false, absent: false });
    expect(parseTeeth(["UR6", "UL6"])).toEqual({
      teeth: [16, 26],
      unparsed: false,
      absent: false,
    });
    expect(parseTeeth("LLE")).toEqual({ teeth: [75], unparsed: false, absent: false });
    // Mixed shapes in one field still read cleanly.
    expect(parseTeeth("UR6,26").teeth).toEqual([16, 26]);
  });

  it("reads a comma or space separated list", () => {
    expect(parseTeeth("16,26")).toEqual({ teeth: [16, 26], unparsed: false, absent: false });
    expect(parseTeeth("16 26")).toEqual({ teeth: [16, 26], unparsed: false, absent: false });
    expect(parseTeeth([16, "26"])).toEqual({ teeth: [16, 26], unparsed: false, absent: false });
  });

  // An empty result would read on screen as "this item concerns no teeth",
  // which is a claim. Unparseable must be SAYABLE, so it is a flag.
  it("reports unparsed rather than returning an innocent empty list", () => {
    expect(parseTeeth("URZ")).toEqual({ teeth: [], unparsed: true, absent: false });
    expect(parseTeeth({ tooth: 16 })).toEqual({ teeth: [], unparsed: true, absent: false });
    expect(parseTeeth([{ tooth: 16 }])).toEqual({ teeth: [], unparsed: true, absent: false });
  });

  // AN ABSENT VALUE IS NOT A FAILED ONE, and conflating them was a real defect:
  // an examination, a radiograph, a hygiene appointment and a denture all name
  // no tooth, and on a real chart those are most of the rows. Reported as
  // failures they printed "some treatment items name teeth this platform could
  // not read" on every patient and filed ordinary treatment under "could not
  // place on a tooth".
  it("separates a field that held nothing from a field it could not read", () => {
    expect(parseTeeth(null)).toEqual({ teeth: [], unparsed: false, absent: true });
    expect(parseTeeth(undefined)).toEqual({ teeth: [], unparsed: false, absent: true });
    expect(parseTeeth("")).toEqual({ teeth: [], unparsed: false, absent: true });
    expect(parseTeeth([])).toEqual({ teeth: [], unparsed: false, absent: true });
  });

  it("keeps what it could read AND flags what it could not", () => {
    expect(parseTeeth("16,URZ")).toEqual({ teeth: [16], unparsed: true, absent: false });
  });

  // The quadrant-less Palmer number is the contralateral trap: "6" is UR6, UL6,
  // LL6 or LR6 and guessing one draws on the wrong side of the mouth.
  it("refuses a Palmer number with no quadrant rather than guessing", () => {
    expect(parseTeeth("6")).toEqual({ teeth: [], unparsed: true, absent: false });
    expect(parseTeeth("E")).toEqual({ teeth: [], unparsed: true, absent: false });
  });

  it("rejects numbers that are not FDI positions", () => {
    expect(parseTeeth(19).teeth).toEqual([]);
    expect(parseTeeth(99).teeth).toEqual([]);
    expect(parseTeeth(0).teeth).toEqual([]);
    expect(parseTeeth(9).teeth).toEqual([]);
    // Quadrants 5-8 hold five teeth each: 56 is not a tooth.
    expect(parseTeeth(56).teeth).toEqual([]);
    expect(parseTeeth(55).teeth).toEqual([55]);
  });

  it("de-duplicates and keeps the order Dentally sent", () => {
    expect(parseTeeth("26,16,26").teeth).toEqual([26, 16]);
  });

  it("round-trips through serialiseTeeth", () => {
    expect(serialiseTeeth([16, 26])).toBe("16,26");
    expect(parseTeeth(serialiseTeeth([16, 26])).teeth).toEqual([16, 26]);
  });
});
