import { describe, it, expect } from "vitest";
import {
  CORRECTION_WINDOW_HOURS,
  DEFAULT_CHART_ENTRY_PREFS,
  ENTRY_ADVANCES,
  ENTRY_ARCHES,
  ENTRY_DIRECTIONS,
  chartEntryPrefsStorageKey,
  cycleScale,
  entryToothOrder,
  hoursLeftInCorrectionWindow,
  parseChartEntryPrefs,
  scaleFromLabels,
  serialiseChartEntryPrefs,
  withinCorrectionWindow,
} from "./chart-entry-prefs";
import type { ChartEntryPrefs } from "./chart-entry-prefs";

// ===========================================================================
// The entry settings, and the three rules the grid is driven by.
//
// These are not decorative tests. Every assertion below stands for something a
// hygienist would notice going wrong at the chairside: the cursor starting in
// the wrong arch, a furcation key that stops on 3 when the engine allows 4, a
// corrupt stored preference blanking a clinical screen, or a "correct this
// exam" button offered on a chart recorded last month.
// ===========================================================================

/** Every reachable combination of the settings. Nine of them; charting is not a
 *  place to spot-check three and hope. */
function everyCombination(): ChartEntryPrefs[] {
  const all: ChartEntryPrefs[] = [];
  for (const startArch of ENTRY_ARCHES) {
    for (const direction of ENTRY_DIRECTIONS) {
      for (const advance of ENTRY_ADVANCES) {
        all.push({ startArch, direction, advance });
      }
    }
  }
  return all;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

describe("the defaults", () => {
  it("start in the upper arch, right to left, moving on by themselves", () => {
    // The UK convention and the order the FDI arch arrays are written in. A
    // practice that never opens the settings gets the order it drew on paper.
    expect(DEFAULT_CHART_ENTRY_PREFS).toEqual({
      startArch: "upper",
      direction: "right-to-left",
      advance: "auto",
    });
  });

  it("are what an absent, empty or unreadable stored value produces", () => {
    for (const raw of [undefined, null, "", "{", "not json", 42, true, [], [1, 2, 3], () => 1]) {
      expect(parseChartEntryPrefs(raw)).toEqual(DEFAULT_CHART_ENTRY_PREFS);
    }
  });

  it("are never handed out as the shared object, so one screen cannot mutate every other", () => {
    const a = parseChartEntryPrefs(null);
    const b = parseChartEntryPrefs(null);
    expect(a).not.toBe(DEFAULT_CHART_ENTRY_PREFS);
    expect(a).not.toBe(b);
    a.advance = "tab";
    expect(DEFAULT_CHART_ENTRY_PREFS.advance).toBe("auto");
    expect(b.advance).toBe("auto");
  });
});

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

describe("persistence", () => {
  it("round-trips every combination through a string, unchanged", () => {
    for (const prefs of everyCombination()) {
      expect(parseChartEntryPrefs(serialiseChartEntryPrefs(prefs))).toEqual(prefs);
    }
  });

  it("round-trips an already-parsed object too, so the caller need not guess", () => {
    for (const prefs of everyCombination()) {
      expect(parseChartEntryPrefs({ ...prefs })).toEqual(prefs);
    }
  });

  it("writes only the three settings, so a wider object cannot smuggle keys into storage", () => {
    const written = serialiseChartEntryPrefs({
      ...DEFAULT_CHART_ENTRY_PREFS,
      // A caller handing over something wider than the interface — which is what
      // happens the first time this is spread out of a bigger state object.
      locked: true,
      clinicianId: "user-1",
    } as unknown as ChartEntryPrefs);
    expect(JSON.parse(written)).toEqual(DEFAULT_CHART_ENTRY_PREFS);
    expect(written).not.toContain("user-1");
  });

  it("keys the settings to the clinician, not to the patient", () => {
    // The way a hygienist charts does not change when the next patient sits
    // down. Two clinicians at one site get their own; one clinician keeps theirs.
    const blerta = chartEntryPrefsStorageKey("site-cc", "user-1");
    const other = chartEntryPrefsStorageKey("site-cc", "user-2");
    expect(blerta).not.toBe(other);
    expect(chartEntryPrefsStorageKey("site-cc", "user-1")).toBe(blerta);
    expect(chartEntryPrefsStorageKey("site-ng", "user-1")).not.toBe(blerta);
    expect(blerta).toContain("user-1");
    expect(blerta).not.toContain("undefined");
    expect(blerta).not.toContain("null");
  });

  it("still produces a usable key with no clinician resolved yet", () => {
    const key = chartEntryPrefsStorageKey("site-cc", null);
    expect(key).toContain("site-cc");
    expect(key).not.toContain("null");
    expect(key).not.toBe(chartEntryPrefsStorageKey("site-cc", "user-1"));
  });
});

// ---------------------------------------------------------------------------
// Corruption
// ---------------------------------------------------------------------------

describe("a corrupt or hostile stored value", () => {
  it("falls back field by field rather than discarding the whole thing", () => {
    // The realistic corruption: one setting written by a newer build, the rest
    // still good. Losing the good ones would be a second bug on top of the first.
    const parsed = parseChartEntryPrefs('{"startArch":"lower","direction":"sideways","advance":7}');
    expect(parsed).toEqual({
      startArch: "lower",
      direction: DEFAULT_CHART_ENTRY_PREFS.direction,
      advance: DEFAULT_CHART_ENTRY_PREFS.advance,
    });
  });

  it("never throws, whatever is in storage", () => {
    const nasties: unknown[] = [
      '{"startArch":{"toString":"no"}}',
      '{"advance":["auto"]}',
      '{"direction":null,"startArch":null,"advance":null}',
      '{"__proto__":{"polluted":true},"startArch":"lower"}',
      '"a bare json string"',
      "[]",
      "null",
      Object.create(null) as unknown,
      new Map(),
      Symbol("x"),
      BigInt(123),
    ];
    for (const raw of nasties) {
      expect(() => parseChartEntryPrefs(raw)).not.toThrow();
      const parsed = parseChartEntryPrefs(raw);
      expect(ENTRY_ARCHES).toContain(parsed.startArch);
      expect(ENTRY_DIRECTIONS).toContain(parsed.direction);
      expect(ENTRY_ADVANCES).toContain(parsed.advance);
    }
  });

  it("does not let a prototype-polluting payload become a setting", () => {
    const parsed = parseChartEntryPrefs('{"__proto__":{"startArch":"lower"}}');
    expect(parsed.startArch).toBe("upper");
    expect(({} as Record<string, unknown>).startArch).toBeUndefined();
  });

  it("drops keys it does not own instead of carrying them forward", () => {
    const parsed = parseChartEntryPrefs({
      startArch: "lower",
      somethingElse: "kept?",
    }) as unknown as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["advance", "direction", "startArch"]);
  });

  it("refuses a value that is the right type but not on the scale", () => {
    // "upper " with a trailing space is the shape of a hand-edited localStorage
    // entry, and it must not be accepted as "upper".
    expect(parseChartEntryPrefs('{"startArch":"upper "}').startArch).toBe("upper");
    expect(parseChartEntryPrefs('{"startArch":"UPPER"}').startArch).toBe("upper");
    expect(parseChartEntryPrefs('{"advance":"Auto"}').advance).toBe("auto");
    // ...and the fallbacks above are the DEFAULT, which happens to read the
    // same. Prove the parser is not simply echoing the input by feeding it a
    // rejected value whose default differs.
    expect(parseChartEntryPrefs('{"startArch":"LOWER"}').startArch).toBe("upper");
  });
});

// ---------------------------------------------------------------------------
// The traversal order
// ---------------------------------------------------------------------------

const UPPER = [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28];
const LOWER = [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38];

describe("the order the cursor sweeps", () => {
  const prefs = (over: Partial<ChartEntryPrefs>): ChartEntryPrefs => ({
    ...DEFAULT_CHART_ENTRY_PREFS,
    ...over,
  });

  it("defaults to the upper right first, which is where a UK chart starts", () => {
    const order = entryToothOrder(DEFAULT_CHART_ENTRY_PREFS, UPPER, LOWER);
    expect(order[0]).toBe(18);
    expect(order[15]).toBe(28);
    expect(order[16]).toBe(48);
    expect(order.at(-1)).toBe(38);
  });

  it("starts in the lower arch when asked, without changing the direction", () => {
    const order = entryToothOrder(prefs({ startArch: "lower" }), UPPER, LOWER);
    expect(order[0]).toBe(48);
    expect(order[15]).toBe(38);
    expect(order[16]).toBe(18);
  });

  it("reverses each arch when the direction is left to right", () => {
    const order = entryToothOrder(prefs({ direction: "left-to-right" }), UPPER, LOWER);
    expect(order[0]).toBe(28);
    expect(order[15]).toBe(18);
    expect(order[16]).toBe(38);
    expect(order.at(-1)).toBe(48);
  });

  it("reverses within each arch, never across the whole mouth", () => {
    // The failure this catches: implementing "left to right" as a reverse of the
    // concatenated list, which also silently swaps which arch comes first and so
    // quietly ignores the arch setting.
    const order = entryToothOrder(
      prefs({ startArch: "lower", direction: "left-to-right" }),
      UPPER,
      LOWER,
    );
    expect(order.slice(0, 16)).toEqual([...LOWER].reverse());
    expect(order.slice(16)).toEqual([...UPPER].reverse());
  });

  it("holds exactly the teeth it was given, once each, in every combination", () => {
    for (const p of everyCombination()) {
      const order = entryToothOrder(p, UPPER, LOWER);
      expect(order).toHaveLength(UPPER.length + LOWER.length);
      expect(new Set(order).size).toBe(order.length);
      expect([...order].sort((a, b) => a - b)).toEqual(
        [...UPPER, ...LOWER].sort((a, b) => a - b),
      );
    }
  });

  it("copes with a partial chart, which is the normal case after a BPE code 3", () => {
    // One sextant only: the upper right. There is no lower arch to visit, and
    // "start with the lower arch" must not produce an empty first move.
    const order = entryToothOrder(prefs({ startArch: "lower" }), [17, 16, 15, 14], []);
    expect(order).toEqual([17, 16, 15, 14]);
  });

  it("returns an empty order for an empty mouth rather than throwing", () => {
    for (const p of everyCombination()) {
      expect(entryToothOrder(p, [], [])).toEqual([]);
    }
  });

  it("does not hand back the caller's own arrays", () => {
    // A returned reference to UPPER would let the cursor's order be reversed in
    // place by the next call, and the chart would silently re-number itself.
    const order = entryToothOrder(DEFAULT_CHART_ENTRY_PREFS, UPPER, []);
    expect(order).not.toBe(UPPER);
    order.reverse();
    expect(UPPER[0]).toBe(18);
  });
});

// ---------------------------------------------------------------------------
// Cycling a scale
// ---------------------------------------------------------------------------

describe("cycling a scale with a repeated keystroke", () => {
  it("cycles Dentally's four furcation grades and then clears", () => {
    const grades = [1, 2, 3, 4];
    expect(cycleScale(grades, null)).toBe(1);
    expect(cycleScale(grades, 1)).toBe(2);
    expect(cycleScale(grades, 2)).toBe(3);
    expect(cycleScale(grades, 3)).toBe(4);
    // THE ONE THAT MATTERS. A hygienist who types a grade 4 furcation and cannot
    // is a hygienist who stops trusting the screen.
    expect(cycleScale(grades, 4)).toBeNull();
  });

  it("cycles Dentally's three mobility stages and then clears", () => {
    const stages = [1, 2, 3];
    expect(cycleScale(stages, null)).toBe(1);
    expect(cycleScale(stages, 3)).toBeNull();
  });

  it("returns to the start after clearing, so the key is a loop and not a dead end", () => {
    const grades = [1, 2, 3, 4];
    let value: number | null = null;
    const seen: (number | null)[] = [];
    for (let press = 0; press < 10; press += 1) {
      value = cycleScale(grades, value);
      seen.push(value);
    }
    expect(seen).toEqual([1, 2, 3, 4, null, 1, 2, 3, 4, null]);
  });

  it("takes a value from an older scale to the first grade, never to nothing", () => {
    // A chart recorded under Miller 0–III, re-opened after the scales were
    // corrected. One press must leave a value the engine will accept.
    expect(cycleScale([1, 2, 3], 0)).toBe(1);
    expect(cycleScale([1, 2, 3, 4], 9)).toBe(1);
  });

  it("survives an empty scale rather than throwing", () => {
    expect(cycleScale([], null)).toBeNull();
    expect(cycleScale([], 1)).toBeNull();
  });

  it("cycles whatever it is handed, because the scale is never written down here", () => {
    // The guard against this module growing its own opinion about the ends of a
    // clinical scale — the exact defect this pass was written to correct.
    expect(cycleScale(["I", "II"], "I")).toBe("II");
    expect(cycleScale(["I", "II"], "II")).toBeNull();
  });
});

describe("reading a scale off its labels", () => {
  it("returns the grades in ascending order", () => {
    expect(scaleFromLabels({ 1: "grade 1", 2: "grade 2", 3: "grade 3", 4: "grade 4" })).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it("sorts numerically rather than as text, so a ten-point scale is not 1, 10, 2", () => {
    expect(scaleFromLabels({ 1: "a", 2: "b", 10: "c" })).toEqual([1, 2, 10]);
  });

  it("does not depend on the order the labels were written in", () => {
    expect(scaleFromLabels({ 3: "c", 1: "a", 2: "b" })).toEqual([1, 2, 3]);
  });

  it("gives an empty scale for no labels, which cycleScale then survives", () => {
    expect(scaleFromLabels({})).toEqual([]);
    expect(cycleScale(scaleFromLabels({}), null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The 24-hour correction window
// ---------------------------------------------------------------------------

describe("the 24-hour correction window", () => {
  const RECORDED = "2026-08-02T09:00:00.000Z";

  it("is Dentally's 24 hours", () => {
    expect(CORRECTION_WINDOW_HOURS).toBe(24);
  });

  it("is open a minute after the chart was recorded", () => {
    expect(withinCorrectionWindow(RECORDED, "2026-08-02T09:01:00.000Z")).toBe(true);
  });

  it("is open at the last second and shut at the first second past", () => {
    expect(withinCorrectionWindow(RECORDED, "2026-08-03T09:00:00.000Z")).toBe(true);
    expect(withinCorrectionWindow(RECORDED, "2026-08-03T09:00:00.001Z")).toBe(false);
  });

  it("is shut on last month's chart", () => {
    expect(withinCorrectionWindow(RECORDED, "2026-09-02T09:00:00.000Z")).toBe(false);
  });

  it("is shut on an instant it cannot read, rather than open", () => {
    // Offering Dentally's familiar edit against a record whose age is unknown is
    // the wrong way to be wrong; the plainly-labelled amendment is never wrong.
    expect(withinCorrectionWindow("not a date", "2026-08-02T09:01:00.000Z")).toBe(false);
    expect(withinCorrectionWindow(RECORDED, "")).toBe(false);
    expect(withinCorrectionWindow("", "")).toBe(false);
  });

  it("is shut on a chart stamped in the future", () => {
    // Clock skew between the server that stamped it and the page that opened.
    expect(withinCorrectionWindow(RECORDED, "2026-08-02T08:59:00.000Z")).toBe(false);
  });

  it("respects a window other than the default when one is passed", () => {
    expect(withinCorrectionWindow(RECORDED, "2026-08-02T10:00:00.000Z", 2)).toBe(true);
    expect(withinCorrectionWindow(RECORDED, "2026-08-02T12:00:00.000Z", 2)).toBe(false);
  });

  it("counts down in whole hours, and reads 0 in the final hour rather than closed", () => {
    expect(hoursLeftInCorrectionWindow(RECORDED, "2026-08-02T09:00:00.000Z")).toBe(24);
    expect(hoursLeftInCorrectionWindow(RECORDED, "2026-08-02T10:30:00.000Z")).toBe(22);
    expect(hoursLeftInCorrectionWindow(RECORDED, "2026-08-03T08:30:00.000Z")).toBe(0);
    expect(hoursLeftInCorrectionWindow(RECORDED, "2026-08-03T09:00:00.000Z")).toBe(0);
  });

  it("has nothing to count once the window is shut", () => {
    expect(hoursLeftInCorrectionWindow(RECORDED, "2026-08-04T09:00:00.000Z")).toBeNull();
    expect(hoursLeftInCorrectionWindow("nonsense", "2026-08-02T09:01:00.000Z")).toBeNull();
  });

  it("never says the window is shut on a chart it says has hours left, or the reverse", () => {
    // The two functions read the same clock-free arithmetic and must not drift.
    const instants = [
      "2026-08-02T08:00:00.000Z",
      "2026-08-02T09:00:00.000Z",
      "2026-08-02T21:00:00.000Z",
      "2026-08-03T08:59:59.999Z",
      "2026-08-03T09:00:00.001Z",
      "2026-08-09T09:00:00.000Z",
      "rubbish",
    ];
    for (const now of instants) {
      const open = withinCorrectionWindow(RECORDED, now);
      const left = hoursLeftInCorrectionWindow(RECORDED, now);
      expect(open, `disagreement at ${now}`).toBe(left !== null);
      if (left !== null) expect(left).toBeGreaterThanOrEqual(0);
    }
  });
});
