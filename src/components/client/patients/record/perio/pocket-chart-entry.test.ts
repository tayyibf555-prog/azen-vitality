import { describe, it, expect } from "vitest";
import {
  amendmentTargetId,
  carriedCount,
  cursorTooth,
  entryKeyAction,
  entryReducer,
  liveBopFrom,
  measuredToday,
  valuesFromRecords,
  type EntryAction,
  type EntryState,
  type EntryValues,
} from "./pocket-chart";
import { SITE_IDS } from "@/lib/perio/pocket-chart";
import type { PerioSiteId, PerioToothRecord } from "@/lib/perio/types";

// ===========================================================================
// THE CLONE, AND THE CARRIED READING.
//
// WHY THIS FILE EXISTS. Two rules that this feature's whole honesty rests on
// lived inside a React closure, where vitest could not reach them — and a
// mutation test proved it: breaking BOTH of them left all 525 perio tests green.
//
//   1. A CLONE IS A NEW EXAMINATION. Feeding the cloned exam's id into
//      `supersedesId` turns "last time's figures, re-probed today" into "today's
//      chart replaces last time's", and an examination that really happened
//      stops standing. No test failed.
//   2. A CARRIED READING WAS NOT TAKEN TODAY. Dropping the carried check turns
//      last visit's numbers into today's measurements — dated today, attributed
//      to today's clinician, and indistinguishable on the record from a mouth
//      somebody actually probed. That is a fabricated clinical record, and no
//      test failed for that either.
//
// Both are now module-level pure functions in pocket-chart.tsx, and both are
// pinned below. Neither behaves differently from the closure it came out of;
// the only change is that a test can see it.
// ===========================================================================

const EARLIER = { id: "chart-june", recorded: { at: "2026-06-01T09:00:00.000Z" } };
const STANDING = { id: "chart-today", recorded: { at: "2026-08-02T08:00:00.000Z" } };

// ---------------------------------------------------------------------------
// 1. A clone never supersedes
// ---------------------------------------------------------------------------

describe("what a save is allowed to supersede", () => {
  it("supersedes nothing for a plain new examination", () => {
    expect(amendmentTargetId({})).toBeNull();
    expect(amendmentTargetId({ supersedesId: null, correcting: null, carriedFrom: null })).toBeNull();
  });

  it("A CLONE SUPERSEDES NOTHING — the exam it copied stays standing", () => {
    // The headline. Dentally's clone "will carry forward the recordings taken on
    // the previous exam into a new exam dated for today": a new exam, beside the
    // old one, not on top of it.
    expect(amendmentTargetId({ carriedFrom: EARLIER })).toBeNull();
  });

  it("still supersedes nothing when a clone and nothing else is in play", () => {
    expect(amendmentTargetId({ supersedesId: null, correcting: null, carriedFrom: EARLIER })).toBeNull();
  });

  it("supersedes the chart being corrected, when one was picked", () => {
    expect(amendmentTargetId({ correcting: STANDING })).toBe("chart-today");
  });

  it("lets the caller's own supersedesId win over a correction picked on screen", () => {
    expect(amendmentTargetId({ supersedesId: "from-the-shell", correcting: STANDING })).toBe(
      "from-the-shell",
    );
  });

  it("supersedes the CORRECTION and never the clone, even with both set", () => {
    // The state this guards is real: a clinician clones June's exam, then thinks
    // better of it and corrects today's. The amendment must point at today's.
    expect(amendmentTargetId({ correcting: STANDING, carriedFrom: EARLIER })).toBe("chart-today");
    expect(amendmentTargetId({ correcting: STANDING, carriedFrom: EARLIER })).not.toBe("chart-june");
  });
});

// ---------------------------------------------------------------------------
// 2. A carried reading is not a measurement
// ---------------------------------------------------------------------------

function cell(over: Partial<{ probingDepth: number | null; carried: boolean }> = {}) {
  return {
    probingDepth: 4,
    recession: 1,
    bleeding: false,
    suppuration: false,
    plaque: false,
    carried: false,
    ...over,
  };
}

describe("what counts as measured today", () => {
  it("counts a depth taken at this appointment", () => {
    expect(measuredToday(cell())).toBe(true);
  });

  it("DOES NOT count a reading carried in from a previous exam", () => {
    // Everything about this cell reads like a measurement — it has a depth, it
    // is drawn on the grid — except that nobody took it today.
    expect(measuredToday(cell({ carried: true }))).toBe(false);
  });

  it("does not count a site with no depth, carried or not", () => {
    expect(measuredToday(cell({ probingDepth: null }))).toBe(false);
    expect(measuredToday(cell({ probingDepth: null, carried: true }))).toBe(false);
  });

  it("does not count a tooth this chart is not drawing at all", () => {
    expect(measuredToday(undefined)).toBe(false);
  });

  it("a zero-millimetre pocket IS a measurement — 0 is a reading, not an absence", () => {
    expect(measuredToday(cell({ probingDepth: 0 }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Cloning marks every carried figure; correcting marks none
// ---------------------------------------------------------------------------

function record(tooth: number, depth: number | null, findings = false): PerioToothRecord {
  return {
    tooth,
    mobility: findings ? 2 : null,
    furcation: findings ? 3 : null,
    sites: SITE_IDS.map((site) => ({
      site,
      probingDepth: depth,
      recession: depth === null ? null : 1,
      bleeding: false,
      suppuration: false,
      plaque: false,
    })),
  };
}

function measuredSites(teeth: readonly number[], values: EntryValues): number {
  let total = 0;
  for (const tooth of teeth) {
    for (const site of SITE_IDS) if (measuredToday(values[tooth]?.sites[site])) total += 1;
  }
  return total;
}

describe("seeding a chart from a stored one", () => {
  const teeth = [16, 15];
  const stored = [record(16, 4, true), record(15, 3)];

  it("a CLONE marks every carried figure and contributes NOTHING to today's chart", () => {
    const values = valuesFromRecords(teeth, stored, true);
    expect(measuredSites(teeth, values)).toBe(0);
    // 12 sites + the one tooth carrying mobility/furcation.
    expect(carriedCount(teeth, values)).toBe(13);
    // The figures ARE there — they are drawn, just not claimed as today's.
    expect(values[16].sites.mb.probingDepth).toBe(4);
    expect(values[16].carriedFindings).toBe(true);
  });

  it("a CORRECTION marks nothing carried — those figures ARE the record it restates", () => {
    const values = valuesFromRecords(teeth, stored, false);
    expect(carriedCount(teeth, values)).toBe(0);
    expect(measuredSites(teeth, values)).toBe(12);
  });

  it("marks nothing on a site the previous exam left unprobed", () => {
    const values = valuesFromRecords([16], [record(16, null)], true);
    expect(carriedCount([16], values)).toBe(0);
    expect(measuredSites([16], values)).toBe(0);
  });

  it("drops teeth the previous exam holds that this screen is not drawing", () => {
    const values = valuesFromRecords([16], [record(16, 4), record(15, 4)], true);
    expect(Object.keys(values)).toEqual(["16"]);
    expect(carriedCount([16], values)).toBe(6);
  });

  it("marks a tooth's findings as carried only when it actually has one", () => {
    const values = valuesFromRecords([15], [record(15, 3, false)], true);
    expect(values[15].carriedFindings).toBe(false);
  });
});

// ===========================================================================
// THE f AND m KEYS — what a hygienist can actually PRODUCE.
//
// The engine refuses a grade off the scale and the route refuses it again, but
// neither is the first line: a scale only the server rejects is a scale the
// screen let somebody type. Dentally's article is explicit — `f` "will cycle
// through furcation grades 1, 2, 3 and 4", `m` through "mobility stages 1-3",
// and "pressing any key again after the final stage removes the recording".
// These pin the cycle itself, so a grade 5 cannot come into existence on the
// way to being refused.
// ===========================================================================

function blankSites() {
  const sites = {} as Record<PerioSiteId, unknown>;
  for (const site of SITE_IDS) {
    sites[site] = {
      probingDepth: null,
      recession: null,
      bleeding: false,
      suppuration: false,
      plaque: false,
      carried: false,
    };
  }
  return sites;
}

function freshEntry(teeth: number[], autoAdvance = true): EntryState {
  const values: Record<number, unknown> = {};
  for (const tooth of teeth) {
    values[tooth] = { mobility: null, furcation: null, carriedFindings: false, sites: blankSites() };
  }
  return {
    teeth,
    values,
    cursor: 0,
    field: "depth",
    pendingDouble: false,
    pendingNegative: false,
    message: null,
    nonce: 0,
    dirty: false,
    restored: false,
    autoAdvance,
  } as unknown as EntryState;
}

/** Drive a run of actions through the machine, as a hand would. */
function run(state: EntryState, ...actions: EntryAction[]): EntryState {
  return actions.reduce(entryReducer, state);
}

/** Every depth on the grid, in cursor order, as `tooth:site=value`. The whole
 *  point of these tests is WHAT WAS RECORDED and WHERE, so the assertions read
 *  the mouth rather than one cell the test already suspects. */
function depths(state: EntryState): string[] {
  const out: string[] = [];
  for (const tooth of state.teeth) {
    for (const site of SITE_IDS) {
      const depth = state.values[tooth]?.sites[site]?.probingDepth;
      if (depth !== null && depth !== undefined) out.push(`${tooth}:${site}=${depth}`);
    }
  }
  return out;
}

function recessions(state: EntryState): string[] {
  const out: string[] = [];
  for (const tooth of state.teeth) {
    for (const site of SITE_IDS) {
      const value = state.values[tooth]?.sites[site]?.recession;
      if (value !== null && value !== undefined) out.push(`${tooth}:${site}=${value}`);
    }
  }
  return out;
}

const digits = (...ds: number[]): EntryAction[] => ds.map((digit) => ({ type: "digit", digit }));
const D: EntryAction = { type: "double" };

describe("the furcation key", () => {
  it("cycles 1, 2, 3, 4, cleared — and can never reach a grade 5 or a grade 0", () => {
    let state = freshEntry([16, 15, 14]);
    const seen: (number | null)[] = [];
    for (let press = 0; press < 12; press += 1) {
      state = entryReducer(state, { type: "furcation" });
      seen.push(state.values[cursorTooth(state)!].furcation);
    }
    expect(seen.slice(0, 10)).toEqual([1, 2, 3, 4, null, 1, 2, 3, 4, null]);
    expect(seen).not.toContain(0);
    expect(seen).not.toContain(5);
  });

  it("refuses a single-rooted tooth in words, and records nothing", () => {
    const state = entryReducer(freshEntry([13, 12, 11]), { type: "furcation" });
    expect(state.values[13].furcation).toBeNull();
    expect(state.message).toMatch(/single-rooted/);
    expect(state.dirty).toBe(false);
  });

  it("announces the grade by the name Dentally gives it", () => {
    const state = entryReducer(freshEntry([16]), { type: "furcation" });
    expect(state.message).toContain("grade 1");
    expect(state.message).not.toMatch(/Hamp|Miller/);
  });
});

describe("the mobility key", () => {
  it("cycles 1, 2, 3, cleared — and can never reach a stage 4 or a stage 0", () => {
    let state = freshEntry([16, 15, 14]);
    const seen: (number | null)[] = [];
    for (let press = 0; press < 10; press += 1) {
      state = entryReducer(state, { type: "mobility" });
      seen.push(state.values[cursorTooth(state)!].mobility);
    }
    expect(seen.slice(0, 8)).toEqual([1, 2, 3, null, 1, 2, 3, null]);
    expect(seen).not.toContain(0);
    expect(seen).not.toContain(4);
  });

  it("announces the stage by the name Dentally gives it", () => {
    const state = entryReducer(freshEntry([16]), { type: "mobility" });
    expect(state.message).toContain("stage 1");
    expect(state.message).not.toMatch(/Hamp|Miller/);
  });

  it("cycles on an incisor too — mobility, unlike furcation, is a finding on any tooth", () => {
    const state = entryReducer(freshEntry([11]), { type: "mobility" });
    expect(state.values[11].mobility).toBe(1);
  });
});

// ===========================================================================
// THE DOUBLE-FIGURE KEY — the one that was recording numbers nobody typed.
//
// DENTALLY'S ARTICLE, VERBATIM ("How to create a perio exam"):
//
//   "Should a patient require a digit higher than 9, simply press 'd' on the
//    keyboard to record a double-digit while typing the number - for example,
//    press 'd' and then 2 to record a 12."
//
// This grid used to bind `d` to the depth FIELD and to pend a typed 1 in case it
// was the start of 10-15. Both halves of that were silently wrong in opposite
// directions, and neither could be reached by any test that existed:
//
//   d 2   meant to be a 12mm pocket. Recorded a 2mm pocket, at the next site,
//         after a field switch that usually changed nothing on screen.
//   1 2   meant to be 1mm here and 2mm next door. Recorded one 12mm pocket.
//
// A fabricated periodontal measurement, produced by behaviour that looks correct.
// The invariant every test below is written against:
//
//   NO KEYSTROKE SEQUENCE MAY RECORD A NUMBER THE CLINICIAN DID NOT INTEND
//   WITHOUT SAYING SO.
//
// The assertions read the WHOLE grid rather than one cell, because "12 is not
// here" is not the claim — "12 is nowhere, and 1 and 2 are where they were
// typed" is.
// ===========================================================================

describe("d, the double-figure key", () => {
  it("records a 12 from d then 2, which is Dentally's own example", () => {
    const state = run(freshEntry([16, 15]), D, ...digits(2));
    expect(depths(state)).toEqual(["16:mb=12"]);
    // And it moved on, exactly as a single digit does.
    expect(state.cursor).toBe(1);
    expect(state.pendingDouble).toBe(false);
  });

  it("reaches both ends of the double figures: 10 and 15", () => {
    expect(depths(run(freshEntry([16]), D, ...digits(0)))).toEqual(["16:mb=10"]);
    expect(depths(run(freshEntry([16]), D, ...digits(5)))).toEqual(["16:mb=15"]);
  });

  it("RECORDS NOTHING for a double figure past the probe's 15mm, and says so", () => {
    // d then 6 is 16mm, which no probe reports. The old machine would have
    // committed a 1 and fed the 6 to the next site — two numbers from a
    // keystroke pair that meant one.
    const state = run(freshEntry([16, 15]), D, ...digits(6));
    expect(depths(state)).toEqual([]);
    expect(state.cursor).toBe(0);
    expect(state.message).toMatch(/16mm/);
    expect(state.message).toMatch(/nothing was recorded/);
  });

  it("shows the prefix rather than holding it silently", () => {
    const state = run(freshEntry([16]), D);
    expect(state.pendingDouble).toBe(true);
    expect(depths(state)).toEqual([]);
    expect(state.message).toMatch(/[Dd]ouble figure/);
  });

  it("SAYS the prefix went nowhere when the cursor moves before a digit follows", () => {
    // d, Tab, 2 — the sequence in which a clinician believes they typed a 12 at
    // one site and the machine puts a 2 at the next. The Tab says so out loud,
    // and the 2 is a 2.
    const afterTab = run(freshEntry([16, 15]), D, { type: "move", by: 1 });
    expect(afterTab.pendingDouble).toBe(false);
    expect(afterTab.message).toMatch(/double-figure d was cleared/);

    const state = run(afterTab, ...digits(2));
    expect(depths(state)).toEqual(["16:b=2"]);
    expect(depths(state).join(" ")).not.toMatch(/=12/);
  });

  it("refuses to stack: a second d does not become a triple figure", () => {
    const state = run(freshEntry([16]), D, D, ...digits(2));
    expect(depths(state)).toEqual(["16:mb=12"]);
  });

  it("works on the recession row too, where 15mm is also the ceiling", () => {
    const state = run(
      freshEntry([16]),
      ...digits(4), // a depth first: a finding at an unprobed site cannot be placed
      { type: "moveTo", index: 0 },
      { type: "toggleField" },
      D,
      ...digits(2),
    );
    expect(recessions(state)).toEqual(["16:mb=12"]);
  });
});

describe("a plain digit is its own number", () => {
  it("records 1 as one millimetre and moves on — it does NOT wait", () => {
    // The mirror image of the d bug. A 1 that waits is a 1 that can swallow the
    // next site's reading.
    const state = run(freshEntry([16, 15]), ...digits(1));
    expect(depths(state)).toEqual(["16:mb=1"]);
    expect(state.cursor).toBe(1);
    expect(state.pendingDouble).toBe(false);
  });

  it("puts 1 then 2 at two sites, and a 12 nowhere", () => {
    const state = run(freshEntry([16, 15]), ...digits(1, 2));
    expect(depths(state)).toEqual(["16:mb=1", "16:b=2"]);
    expect(depths(state).join(" ")).not.toMatch(/=12/);
  });

  it("still takes a plain run of readings across a tooth", () => {
    const state = run(freshEntry([16, 15]), ...digits(3, 2, 4, 3, 2, 3));
    expect(depths(state)).toEqual([
      "16:mb=3",
      "16:b=2",
      "16:db=4",
      "16:ml=3",
      "16:l=2",
      "16:dl=3",
    ]);
  });

  it("records a zero, because 0mm is a reading", () => {
    expect(depths(run(freshEntry([16]), ...digits(0)))).toEqual(["16:mb=0"]);
  });
});

describe("with auto-advance off, which is Dentally's wait-for-Tab setting", () => {
  it("records the double figure and leaves the cursor where it is", () => {
    const state = run(freshEntry([16, 15], false), D, ...digits(2));
    expect(depths(state)).toEqual(["16:mb=12"]);
    expect(state.cursor).toBe(0);
  });

  it("lets the next digit REPLACE, and never extend into a number nobody typed", () => {
    // The old machine accumulated here: 1 then 2 became 12 with the cursor still
    // on the same site. d is the only way to a double figure now, in both modes.
    const state = run(freshEntry([16], false), ...digits(1, 2));
    expect(depths(state)).toEqual(["16:mb=2"]);
    expect(depths(state).join(" ")).not.toMatch(/=12/);
  });
});

describe("a negative recession", () => {
  it("records a margin coronal to the CEJ", () => {
    const state = run(
      freshEntry([16]),
      ...digits(4),
      { type: "moveTo", index: 0 },
      { type: "toggleField" },
      { type: "sign" },
      ...digits(3),
    );
    expect(recessions(state)).toEqual(["16:mb=-3"]);
  });

  it("records NOTHING past the engine's floor, and leaves the cursor put", () => {
    const state = run(
      freshEntry([16, 15]),
      ...digits(4),
      { type: "moveTo", index: 0 },
      { type: "toggleField" },
      { type: "sign" },
      ...digits(9),
    );
    expect(recessions(state)).toEqual([]);
    expect(state.cursor).toBe(0);
    expect(state.message).toMatch(/-9mm is outside/);
  });

  it("refuses a minus on the depth row rather than negating a pocket", () => {
    const state = run(freshEntry([16]), { type: "sign" });
    expect(state.pendingNegative).toBe(false);
    expect(state.message).toMatch(/cannot be negative/);
  });
});

describe("r, the row switch", () => {
  it("toggles between depth and recession, and names the row it lands on", () => {
    const one = run(freshEntry([16]), { type: "toggleField" });
    expect(one.field).toBe("recession");
    expect(one.message).toMatch(/recession/);
    const two = run(one, { type: "toggleField" });
    expect(two.field).toBe("depth");
    expect(two.message).toMatch(/probing depth/);
  });

  it("is not d — d no longer touches the row at all", () => {
    // The collision itself, pinned. `d` on the depth row must leave the row alone
    // and start a double figure; anything else is the original defect returning.
    const state = run(freshEntry([16]), D);
    expect(state.field).toBe("depth");
    expect(state.pendingDouble).toBe(true);
  });
});

describe("a refused reading never moves the cursor", () => {
  it("keeps the cursor on the site the clinician is still trying to record", () => {
    // If the cursor advanced over a rejection, the retyped number would land one
    // site along — a correct-looking correction, recorded in the wrong place.
    const state = run(freshEntry([16, 15]), D, ...digits(9));
    expect(state.cursor).toBe(0);
    const retyped = run(state, D, ...digits(2));
    expect(depths(retyped)).toEqual(["16:mb=12"]);
  });
});

// ===========================================================================
// THE LIVE BLEEDING SCORE — Dentally: "A live % Bleeding on Probing (BOP) score
// will appear at the top of the perio chart."
//
// The engine has computed one since the day it was written. Nothing imported it,
// and the grid showed "N of 168 sites" — a progress bar — in its place. The
// mapping from the entry grid into the engine is the part that can be wrong, so
// it is a pure exported function and these pin it.
// ===========================================================================

function bopValues(spec: Record<number, { depth: number | null; bleeding?: boolean; carried?: boolean }[]>): EntryValues {
  const values = {} as EntryValues;
  for (const [tooth, sites] of Object.entries(spec)) {
    const built = {} as Record<PerioSiteId, unknown>;
    SITE_IDS.forEach((site, index) => {
      const at = sites[index];
      built[site] = {
        probingDepth: at?.depth ?? null,
        recession: null,
        bleeding: Boolean(at?.bleeding),
        suppuration: false,
        plaque: false,
        carried: Boolean(at?.carried),
      };
    });
    values[Number(tooth)] = {
      mobility: null,
      furcation: null,
      carriedFindings: false,
      sites: built,
    } as unknown as EntryValues[number];
  }
  return values;
}

describe("the live BOP score, from the grid as it stands", () => {
  it("is a percentage of the sites PROBED SO FAR, not of the sites on screen", () => {
    // Half a tooth probed, one of them bleeding. If the denominator were the
    // cells drawn, the score would fall every time the cursor reached a tooth
    // nobody has touched yet — bleeding appearing to improve as the exam goes on.
    const values = bopValues({
      16: [{ depth: 4, bleeding: true }, { depth: 3 }, { depth: 3 }],
      15: [],
    });
    const score = liveBopFrom([16, 15], values);
    expect(score.sitesProbed).toBe(3);
    expect(score.bleedingSites).toBe(1);
    expect(score.percent).toBe(33.3);
    expect(score.label).toContain("3 probed sites");
  });

  it("EXCLUDES a carried reading from both halves of the fraction", () => {
    // A cloned site has a depth and is drawn, but nobody probed it today. Counting
    // it would print a bleeding score for an examination that has not happened.
    const values = bopValues({
      16: [
        { depth: 4, bleeding: true, carried: true },
        { depth: 5, bleeding: true, carried: true },
        { depth: 2 },
      ],
    });
    const score = liveBopFrom([16], values);
    expect(score.sitesProbed).toBe(1);
    expect(score.bleedingSites).toBe(0);
    expect(score.percent).toBe(0);
  });

  it("has NO score before anything has been probed — never a reassuring 0%", () => {
    const score = liveBopFrom([16], bopValues({ 16: [] }));
    expect(score.percent).toBeNull();
    expect(score.label).toMatch(/no site has been probed yet/);
  });

  it("counts a bleeding site only where a depth was taken", () => {
    const values = bopValues({ 16: [{ depth: 6, bleeding: true }, { depth: 4, bleeding: true }] });
    expect(liveBopFrom([16], values).percent).toBe(100);
  });

  it("ignores a tooth the grid is not drawing", () => {
    const values = bopValues({ 16: [{ depth: 4, bleeding: true }], 15: [{ depth: 3 }] });
    expect(liveBopFrom([16], values).sitesProbed).toBe(1);
  });
});

// ===========================================================================
// WHICH KEY MEANS WHAT — the mapping, not the machine.
//
// THIS SECTION EXISTS BECAUSE A MUTATION SURVIVED. Everything above tests the
// reducer, which takes ACTIONS; the keyboard turned keystrokes into actions
// inside a useCallback, where no test in this repo could see it. Pointing `d`
// back at the depth field — the exact defect this module was fixed for — left
// all 492 perio tests green.
//
// So the mapping is a pure function now, and this is the test that would have
// caught it.
// ===========================================================================

describe("the keyboard mapping", () => {
  it("gives d to Dentally's double figure, and to nothing else", () => {
    expect(entryKeyAction("d")).toEqual({ type: "double" });
    expect(entryKeyAction("D")).toEqual({ type: "double" });
  });

  it("NEVER maps any key to selecting a field outright", () => {
    // The original collision in one assertion: `d` (or anything) meaning
    // "switch to the depth row" is what silently turned d-2 into a 2.
    const everyKey = [
      ..."abcdefghijklmnopqrstuvwxyz",
      ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      ..."0123456789",
      "-",
      "_",
      " ",
      "Tab",
      "Enter",
      "Escape",
      "Backspace",
      "Delete",
      "Home",
      "End",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
    ];
    for (const key of everyKey) {
      const action = entryKeyAction(key);
      expect(action?.type, `${key} maps to a field selection`).not.toBe("field");
    }
  });

  it("puts the row switch on r, and makes it a toggle rather than a target", () => {
    expect(entryKeyAction("r")).toEqual({ type: "toggleField" });
    expect(entryKeyAction("R")).toEqual({ type: "toggleField" });
  });

  it("reads a digit as itself", () => {
    expect(entryKeyAction("0")).toEqual({ type: "digit", digit: 0 });
    expect(entryKeyAction("1")).toEqual({ type: "digit", digit: 1 });
    expect(entryKeyAction("9")).toEqual({ type: "digit", digit: 9 });
  });

  it("keeps Dentally's other letters where they were", () => {
    expect(entryKeyAction("b")).toEqual({ type: "flag", flag: "bleeding" });
    expect(entryKeyAction("s")).toEqual({ type: "flag", flag: "suppuration" });
    expect(entryKeyAction("p")).toEqual({ type: "flag", flag: "plaque" });
    expect(entryKeyAction("m")).toEqual({ type: "mobility" });
    expect(entryKeyAction("f")).toEqual({ type: "furcation" });
  });

  it("moves, clears and leaves", () => {
    expect(entryKeyAction("Tab")).toEqual({ type: "move", by: 1 });
    expect(entryKeyAction("Tab", true)).toEqual({ type: "move", by: -1 });
    expect(entryKeyAction("ArrowLeft")).toEqual({ type: "move", by: -1 });
    expect(entryKeyAction("ArrowDown")).toEqual({ type: "row", delta: 3 });
    expect(entryKeyAction("ArrowUp")).toEqual({ type: "row", delta: -3 });
    expect(entryKeyAction("Backspace")).toEqual({ type: "clear" });
    expect(entryKeyAction("Escape")).toEqual({ type: "leaveGrid" });
  });

  it("ignores a key it has no meaning for, rather than swallowing it", () => {
    for (const key of ["z", "F5", "Shift", "Control", "PageDown", "/"]) {
      expect(entryKeyAction(key), `${key} was claimed`).toBeNull();
    }
  });

  it("drives the machine end to end from keystrokes alone", () => {
    // The two halves joined: keys in, readings out, with nothing in between that
    // a test cannot see. This is the hygienist's own d-2 for a 12mm pocket.
    let state = freshEntry([16, 15]);
    for (const key of ["d", "2", "4", "3"]) {
      const action = entryKeyAction(key);
      if (action && action.type !== "leaveGrid") state = entryReducer(state, action);
    }
    expect(depths(state)).toEqual(["16:mb=12", "16:b=4", "16:db=3"]);
  });
});

describe("a reading the engine cannot place", () => {
  it("is refused WITHOUT moving the cursor, so the retype lands where it was meant to", () => {
    // A recession at a site nobody probed cannot be placed — the engine refuses
    // it on save, and the grid refuses it at the keystroke. If the cursor
    // advanced over that refusal, the recession the clinician retypes would land
    // on the NEXT site, correct-looking and in the wrong place.
    const state = run(freshEntry([16, 15]), { type: "toggleField" }, ...digits(2));
    expect(recessions(state)).toEqual([]);
    expect(state.cursor).toBe(0);
    expect(state.message).toMatch(/record the probing depth before the recession/);
  });
});
