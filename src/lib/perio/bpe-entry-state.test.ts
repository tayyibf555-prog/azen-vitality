import { describe, it, expect } from "vitest";
import {
  ADJACENT_SEXTANT,
  MIN_TEETH_PER_SEXTANT,
  SEXTANTS,
  SEXTANT_LABEL,
  SEXTANT_TEETH,
  BPE_TEETH,
  serialiseBpeScore,
} from "./bpe";
import type { BpeCode, SextantId } from "./types";
import {
  bpeEntryReducer,
  canScore,
  cursorSextant,
  entryRequirement,
  initBpeEntry,
  isComplete,
  saveRefusal,
  skipReason,
  toSavePayload,
  travelOrder,
  unscoredSextants,
  type BpeEntryAction,
  type BpeEntryState,
} from "./bpe-entry-state";

// ===========================================================================
// THE BPE ENTRY MACHINE.
//
// SIX NUMBERS, TYPED AT EVERY EXAMINATION, and the screening layer that decides
// whether a 192-number six-point chart is owed. PERIO.md §4: "Entry speed is the
// whole feature." So the machine takes VALUES and COMMANDS, never keystrokes —
// `{ type: "code", code: 3 }` means "three in the sextant at the cursor, then move
// on", and it does not care whether a finger, a barcode scanner or a transcript of
// an assistant reading aloud produced the 3.
//
// WHAT THESE TESTS ARE FOR. Four properties of this machine are clinical rather
// than cosmetic, and each is checked here rather than asserted in a comment:
//
//   1. THE TRAVEL ORDER IS THE CLINICAL ORDER. UR, UA, UL, then LR, LA, LL — the
//      order a clinician probes and calls out. Any other order makes them
//      translate between what they said and where the cursor is, at speed, with
//      their eyes in someone's mouth.
//   2. A SEXTANT THAT CANNOT BE SCORED CAN NEVER RECEIVE A SCORE. Not by typing,
//      not by jumping to it, not with the cursor forced onto it. A sextant with
//      fewer than MIN_TEETH_PER_SEXTANT qualifying teeth is recorded with its
//      neighbour; a 0 written there is a claim of health nobody made.
//   3. THE `*` IS ADDITIVE AND SITS ON ANY CODE. "0*" and "4*" are both real.
//   4. OUT-OF-RANGE INPUT IS REFUSED, NOT CLAMPED. A 5 is not a 4.
//
// The engine (bpe.ts) is not re-implemented here and its answers are not
// restated: the travel order is read from SEXTANTS, the skip threshold from
// MIN_TEETH_PER_SEXTANT, the requirement from chartingRequirement. A test that
// hard-coded any of them would pass against a machine that had drifted from the
// engine, which is the only failure worth catching.
// ===========================================================================

/** The whole mouth, so every sextant qualifies. The ordinary case. */
function full(): BpeEntryState {
  return initBpeEntry({ presentTeeth: BPE_TEETH });
}

/** A mouth whose upper right holds ONE tooth: below MIN_TEETH_PER_SEXTANT, so
 *  that sextant cannot be scored and is recorded with its neighbour. */
function crippledUpperRight(): BpeEntryState {
  const teeth = BPE_TEETH.filter((t) => !SEXTANT_TEETH.UR.includes(t) || t === 17);
  return initBpeEntry({ presentTeeth: teeth });
}

function run(state: BpeEntryState, ...actions: BpeEntryAction[]): BpeEntryState {
  return actions.reduce(bpeEntryReducer, state);
}

function code(n: number): BpeEntryAction {
  return { type: "code", code: n };
}

/** Where the cursor is, as a sextant id. */
function at(state: BpeEntryState): SextantId | null {
  return cursorSextant(state);
}

// ---------------------------------------------------------------------------
// 1. The travel order
// ---------------------------------------------------------------------------

describe("the travel order is the clinical order", () => {
  it("starts at the upper right and runs UR, UA, UL, LR, LA, LL", () => {
    // Read from the engine, not typed out: this test is checking that the machine
    // follows bpe.ts's order, not that it follows a list in this file.
    expect(travelOrder(full())).toEqual([...SEXTANTS]);
    expect(SEXTANTS).toEqual(["UR", "UA", "UL", "LR", "LA", "LL"]);
    expect(at(full())).toBe("UR");
  });

  it("advances one sextant per code, in that order, without a mouse", () => {
    let state = full();
    const visited: (SextantId | null)[] = [at(state)];
    for (const c of [0, 1, 2, 3, 4] as BpeCode[]) {
      state = bpeEntryReducer(state, code(c));
      visited.push(at(state));
    }
    expect(visited).toEqual(["UR", "UA", "UL", "LR", "LA", "LL"]);
    expect(SEXTANTS.map((s) => state.scores[s]?.code ?? null)).toEqual([0, 1, 2, 3, 4, null]);
  });

  it("stops at the last sextant rather than wrapping onto a score already taken", () => {
    let state = full();
    for (const c of [0, 0, 0, 0, 0, 0]) state = bpeEntryReducer(state, code(c));
    expect(at(state)).toBe("LL");
    // A wrap would put the next number back on the upper right, over a score the
    // clinician already gave. It says so instead.
    const after = bpeEntryReducer(state, code(4));
    expect(after.scores.LL?.code).toBe(4);
    expect(after.scores.UR?.code).toBe(0);
    expect(after.message).toMatch(/last sextant/i);
  });

  it("moves both ways with the arrows and clamps at each end", () => {
    let state = full();
    state = run(state, { type: "move", by: 2 });
    expect(at(state)).toBe("UL");
    state = run(state, { type: "move", by: -1 });
    expect(at(state)).toBe("UA");
    state = run(state, { type: "move", by: -9 });
    expect(at(state)).toBe("UR");
    state = run(state, { type: "move", by: 99 });
    expect(at(state)).toBe("LL");
  });
});

// ---------------------------------------------------------------------------
// 2. The skip rule. The one that must never be got wrong.
// ---------------------------------------------------------------------------

describe("a sextant that cannot be scored", () => {
  it("is left out of the travel order entirely", () => {
    const state = crippledUpperRight();
    expect(state.statuses.UR).toBe("insufficient-teeth");
    expect(travelOrder(state)).toEqual(SEXTANTS.filter((s) => s !== "UR"));
    // The cursor therefore OPENS on the upper anterior, not on a box that cannot
    // hold a number.
    expect(at(state)).toBe("UA");
  });

  it("is stepped over by ordinary travel, in both directions", () => {
    let state = crippledUpperRight();
    expect(at(state)).toBe("UA");
    state = run(state, { type: "move", by: -1 });
    expect(at(state)).toBe("UA");
    state = run(state, { type: "move", by: 1 }, { type: "move", by: -1 });
    expect(at(state)).toBe("UA");
  });

  it("says WHY, and names the adjacent sextant its teeth are recorded with", () => {
    const reason = skipReason(crippledUpperRight(), "UR");
    expect(reason).toBeTruthy();
    expect(reason).toContain(String(MIN_TEETH_PER_SEXTANT));
    // ADJACENT_SEXTANT.UR is the upper anterior. The sentence must NAME it: "this
    // sextant was skipped" leaves a clinician looking for the reading.
    expect(ADJACENT_SEXTANT.UR).toBe("UA");
    expect(reason).toContain(SEXTANT_LABEL.UA);
    // And it must say, in words, that this is not a zero.
    expect(reason).toMatch(/never a 0|not a score of 0/i);
  });

  it("declines to name a side for an anterior sextant, which has a neighbour on each", () => {
    // bpe.ts leaves ADJACENT_SEXTANT null for the anterior sextants deliberately:
    // the answer is only ever per tooth, and naming one end would record a reading
    // on the wrong side of the midline.
    expect(ADJACENT_SEXTANT.UA).toBeNull();
    const state = initBpeEntry({ presentTeeth: [11, 17, 16, 24, 25, 34, 35, 44, 45, 41, 42] });
    // 11 alone in the upper anterior.
    expect(state.statuses.UA).toBe("insufficient-teeth");
    const reason = skipReason(state, "UA");
    expect(reason).toBeTruthy();
    expect(reason).toContain(SEXTANT_LABEL.UR);
  });

  it("REFUSES A SCORE EVEN WITH THE CURSOR FORCED ONTO IT", () => {
    // THE MUTATION. travelOrder() already excludes the upper right, so no sequence
    // of legal actions can park the cursor there. This forges the state the guard
    // exists for — a cursor pointing at a sextant that cannot hold a number — and
    // types a 3 into it. Without the check inside the reducer this writes a score
    // to UR and the save sends a reading for a sextant the mouth cannot support.
    const forged: BpeEntryState = { ...crippledUpperRight(), cursor: "UR" };
    const after = bpeEntryReducer(forged, code(3));
    expect(after.scores.UR).toBeNull();
    expect(after.dirty).toBe(false);
    expect(after.message).toContain(SEXTANT_LABEL.UR);
    expect(after.message).toContain(SEXTANT_LABEL.UA);
  });

  it("refuses a jump to it, and leaves the cursor where it was", () => {
    const state = crippledUpperRight();
    const after = bpeEntryReducer(state, { type: "moveTo", sextant: "UR" });
    expect(at(after)).toBe("UA");
    expect(after.message).toContain(SEXTANT_LABEL.UR);
  });

  it("refuses a furcation star on it too — a star is a finding at a sextant", () => {
    const forged: BpeEntryState = { ...crippledUpperRight(), cursor: "UR" };
    const after = bpeEntryReducer(forged, { type: "furcation" });
    expect(after.scores.UR).toBeNull();
    expect(after.dirty).toBe(false);
  });

  it("never becomes scorable through the machine when the dentition is known", () => {
    // The chart says this sextant has one tooth. A clinician cannot type it back
    // into existence, and cannot type it out of existence either.
    const state = crippledUpperRight();
    expect(state.dentitionKnown).toBe(true);
    for (const action of [
      { type: "clear" } as const,
      { type: "declareUnscorable", sextant: "UR", status: "no-teeth" } as const,
      { type: "undeclare", sextant: "UR" } as const,
    ]) {
      const after = bpeEntryReducer({ ...state, cursor: "UR" }, action);
      expect(after.statuses.UR).toBe("insufficient-teeth");
      expect(after.scores.UR).toBeNull();
    }
  });

  it("carries the whole mouth's worth of them: nothing is scorable, nothing is typed", () => {
    // Every sextant down to one tooth. A degenerate mouth, and the screen must not
    // have a cursor at all rather than pretending to.
    const state = initBpeEntry({ presentTeeth: [17, 11, 24, 47, 41, 34] });
    expect(travelOrder(state)).toEqual([]);
    expect(at(state)).toBeNull();
    const after = bpeEntryReducer(state, code(2));
    expect(SEXTANTS.every((s) => after.scores[s] === null)).toBe(true);
    expect(after.dirty).toBe(false);
  });

  it("does not count an implant towards the two teeth a sextant needs", () => {
    // BPE is never used around implants (PERIO.md §3.1), so an implant cannot make
    // a sextant up to MIN_TEETH_PER_SEXTANT.
    const state = initBpeEntry({ presentTeeth: [17, 16, 13, 12, 11, 24, 25, 47, 46, 41, 42, 34, 35], implantTeeth: [16] });
    expect(state.statuses.UR).toBe("insufficient-teeth");
    expect(travelOrder(state)).not.toContain("UR");
  });
});

// ---------------------------------------------------------------------------
// 3. The star
// ---------------------------------------------------------------------------

describe("the furcation star", () => {
  it("sits on every code, 0 through 4, and round-trips through the engine's writer", () => {
    // "THREE STAR" IS ONE UTTERANCE. The code has already advanced the cursor by
    // the time the star arrives, so the star must reach back to the number just
    // given rather than land on the empty sextant in front of it.
    for (const c of [0, 1, 2, 3, 4] as BpeCode[]) {
      const state = run(full(), code(c), { type: "furcation" });
      expect(state.scores.UR).toEqual({ code: c, furcation: true });
      expect(serialiseBpeScore(state.scores.UR!)).toBe(`${c}*`);
      // And it did NOT leak onto the sextant the cursor moved to.
      expect(state.scores.UA).toBeNull();
    }
  });

  it("toggles: pressing it twice leaves the code and clears the star", () => {
    const state = run(full(), code(3), { type: "furcation" }, { type: "furcation" });
    expect(state.scores.UR).toEqual({ code: 3, furcation: false });
  });

  it("does not move the cursor, because it modifies a number already given", () => {
    const state = run(full(), code(3));
    expect(at(state)).toBe("UA");
    expect(at(bpeEntryReducer(state, { type: "furcation" }))).toBe("UA");
  });

  it("marks the sextant under the cursor when that one already holds a score", () => {
    const state = run(full(), code(3), code(1), { type: "move", by: -1 });
    expect(at(state)).toBe("UA");
    const after = bpeEntryReducer(state, { type: "furcation" });
    expect(after.scores.UA).toEqual({ code: 1, furcation: true });
    expect(after.scores.UR).toEqual({ code: 3, furcation: false });
  });

  it("stops reaching back once the cursor has been moved deliberately", () => {
    // A star typed a minute later, after a move, must not silently modify a score
    // three sextants away.
    const state = run(full(), code(3), { type: "move", by: 1 });
    expect(at(state)).toBe("UL");
    const after = bpeEntryReducer(state, { type: "furcation" });
    expect(after.scores.UR).toEqual({ code: 3, furcation: false });
    expect(after.dirty).toBe(true); // from the 3, not from the star
    expect(after.message).toMatch(/furcation/i);
  });

  it("is refused when nothing has been scored yet, and writes nothing", () => {
    const after = bpeEntryReducer(full(), { type: "furcation" });
    expect(after.scores.UR).toBeNull();
    expect(after.dirty).toBe(false);
    expect(after.message).toMatch(/furcation/i);
  });

  it("does not by itself raise the charting requirement", () => {
    // bpe.ts escalates on codes 3 and 4 only and surfaces the star as an advisory
    // instead. The machine must not quietly apply the stronger reading.
    const state = run(full(), code(0), { type: "furcation" });
    const requirement = entryRequirement(state);
    expect(requirement.kind).toBe("none");
    expect(requirement.furcationPresent).toBe(true);
    expect(requirement.advisories.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 4. What is not a BPE code
// ---------------------------------------------------------------------------

describe("out-of-range input", () => {
  it("refuses 5 through 9 rather than clamping them to 4", () => {
    // A 5 clamped to a 4 is a full-mouth six-point chart nobody asked for; a 5
    // clamped to nothing is a sextant with no reading. Neither is acceptable, so
    // it is refused out loud and the cursor stays put.
    for (const n of [5, 6, 7, 8, 9]) {
      const after = bpeEntryReducer(full(), code(n));
      expect(after.scores.UR, `${n} was accepted`).toBeNull();
      expect(at(after)).toBe("UR");
      expect(after.dirty).toBe(false);
      expect(after.message).toMatch(/0 to 4|0, 1, 2, 3 or 4/);
    }
  });

  it("refuses a negative, a fraction, a NaN and an Infinity", () => {
    for (const n of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const after = bpeEntryReducer(full(), code(n));
      expect(after.scores.UR, `${n} was accepted`).toBeNull();
      expect(after.dirty).toBe(false);
    }
  });

  it("accepts every code the engine accepts, and only those", () => {
    for (const n of [0, 1, 2, 3, 4]) {
      expect(bpeEntryReducer(full(), code(n)).scores.UR).toEqual({ code: n, furcation: false });
    }
  });
});

// ---------------------------------------------------------------------------
// Clearing, and what a cleared box is
// ---------------------------------------------------------------------------

describe("clearing a sextant", () => {
  it("removes the score and leaves the sextant scorable — a blank is not a status", () => {
    const state = run(full(), code(4), { type: "move", by: -1 }, { type: "clear" });
    expect(state.scores.UR).toBeNull();
    // The critical half: clearing must not turn into a claim about the dentition.
    expect(state.statuses.UR).toBe("scorable");
    expect(canScore(state, "UR")).toBe(true);
    expect(unscoredSextants(state)).toContain("UR");
  });

  it("takes the furcation star with it", () => {
    const state = run(full(), code(3), { type: "furcation" }, { type: "move", by: -1 }, { type: "clear" });
    expect(state.scores.UR).toBeNull();
    expect(run(state, code(3)).scores.UR).toEqual({ code: 3, furcation: false });
  });
});

// ---------------------------------------------------------------------------
// Declaring a sextant unscorable when the platform does not know the dentition
// ---------------------------------------------------------------------------

describe("declaring a sextant unscorable", () => {
  it("is offered only when the platform does not know which teeth are present", () => {
    const unknown = initBpeEntry({});
    expect(unknown.dentitionKnown).toBe(false);
    // With no dentition supplied every sextant opens scorable, because the machine
    // must not invent a mouth: assuming teeth are missing would skip a sextant a
    // clinician can see and can score.
    expect(travelOrder(unknown)).toEqual([...SEXTANTS]);

    const after = bpeEntryReducer(unknown, {
      type: "declareUnscorable",
      sextant: "UR",
      status: "no-teeth",
    });
    expect(after.statuses.UR).toBe("no-teeth");
    expect(travelOrder(after)).toEqual(SEXTANTS.filter((s) => s !== "UR"));
    expect(at(after)).toBe("UA");
  });

  it("is refused when the chart already answers the question", () => {
    const known = full();
    const after = bpeEntryReducer(known, {
      type: "declareUnscorable",
      sextant: "UR",
      status: "no-teeth",
    });
    expect(after.statuses.UR).toBe("scorable");
    expect(after.message).toBeTruthy();
  });

  it("drops any score the sextant was holding, rather than storing both", () => {
    const unknown = initBpeEntry({});
    const state = run(unknown, code(3), {
      type: "declareUnscorable",
      sextant: "UR",
      status: "insufficient-teeth",
    } as const);
    expect(state.scores.UR).toBeNull();
    expect(state.statuses.UR).toBe("insufficient-teeth");
  });

  it("is reversible, so a mis-key is not a permanent claim about the mouth", () => {
    const unknown = initBpeEntry({});
    const declared = run(unknown, { type: "declareUnscorable", sextant: "UR", status: "no-teeth" });
    // NO FORGED CURSOR. The cursor has moved on to UA, and the sextant being
    // taken back is named — which is the only way the control under a box can
    // ever undo the declaration made on that box. It used to act on the cursor,
    // and since the cursor can never rest on an unscorable sextant, the
    // declaration was in practice permanent.
    const undone = bpeEntryReducer(declared, { type: "undeclare", sextant: "UR" });
    expect(undone.statuses.UR).toBe("scorable");
    expect(travelOrder(undone)).toEqual([...SEXTANTS]);
  });

  // -------------------------------------------------------------------------
  // THE DECLARATION IS ABOUT A SEXTANT, NEVER ABOUT WHERE THE CURSOR IS.
  //
  // The control that dispatches this sits under ONE box and says so on its face.
  // While the action carried no sextant it acted on the cursor, so pressing it
  // under the upper left declared whichever sextant the last number had left the
  // cursor on — destroying the score in it and, with it, the charting obligation
  // that score had created. Measured in the browser before these tests existed.
  // -------------------------------------------------------------------------

  it("declares the sextant it names, not the one under the cursor", () => {
    const unknown = initBpeEntry({});
    // A 2 in the upper right leaves the cursor on the upper anterior.
    const scored = run(unknown, code(2));
    expect(at(scored)).toBe("UA");

    const after = bpeEntryReducer(scored, {
      type: "declareUnscorable",
      sextant: "UL",
      status: "insufficient-teeth",
    });
    expect(after.statuses.UL).toBe("insufficient-teeth");
    expect(after.statuses.UA).toBe("scorable");
    // And the cursor has not been dragged off the sextant the clinician was on.
    expect(at(after)).toBe("UA");
  });

  it("never destroys a score in a sextant it was not asked about", () => {
    const unknown = initBpeEntry({});
    // 2 and 3 in, cursor now resting on the upper left, which holds the 3.
    const scored = run(unknown, code(2), code(3), { type: "move", by: -1 });
    expect(at(scored)).toBe("UA");
    expect(scored.scores.UA?.code).toBe(3);

    const after = bpeEntryReducer(scored, {
      type: "declareUnscorable",
      sextant: "LL",
      status: "insufficient-teeth",
    });
    expect(after.scores.UR?.code).toBe(2);
    expect(after.scores.UA?.code).toBe(3);
    // The requirement a code 3 creates survives a declaration elsewhere.
    expect(entryRequirement(after).kind).toBe("sextant-6-point");
  });

  it("undeclares the sextant it names, leaving the others alone", () => {
    const unknown = initBpeEntry({});
    const declared = run(
      unknown,
      { type: "declareUnscorable", sextant: "UA", status: "insufficient-teeth" },
      { type: "declareUnscorable", sextant: "UL", status: "insufficient-teeth" },
    );
    const undone = bpeEntryReducer(declared, { type: "undeclare", sextant: "UA" });
    expect(undone.statuses.UA).toBe("scorable");
    expect(undone.statuses.UL).toBe("insufficient-teeth");
  });

  it("says nothing, and changes nothing, when asked to undeclare a scorable sextant", () => {
    // Otherwise the screen announces that a sextant "can be scored again" when
    // nobody ever said it could not.
    const unknown = initBpeEntry({});
    const after = bpeEntryReducer(unknown, { type: "undeclare", sextant: "LR" });
    expect(after.statuses.LR).toBe("scorable");
    expect(after.dirty).toBe(false);
    expect(after.message).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The requirement, live, from the engine
// ---------------------------------------------------------------------------

describe("the charting requirement, as scores go in", () => {
  it("says nothing at all until something is scored", () => {
    const requirement = entryRequirement(full());
    expect(requirement.kind).toBe("none");
    expect(requirement.highest).toBeNull();
    expect(requirement.reason).toMatch(/no sextant was scored/i);
  });

  it("a 3 demands a six-point chart of THAT sextant, after initial therapy", () => {
    const state = run(full(), code(0), code(3), code(0));
    const requirement = entryRequirement(state);
    expect(requirement.kind).toBe("sextant-6-point");
    expect(requirement.timing).toBe("after-initial-therapy");
    expect(requirement.sextants).toEqual(["UA"]);
  });

  it("a 4 anywhere demands a full-mouth chart from the outset", () => {
    const state = run(full(), code(0), code(3), code(0), code(0), code(0), code(4));
    const requirement = entryRequirement(state);
    expect(requirement.kind).toBe("full-mouth-6-point");
    expect(requirement.timing).toBe("immediate");
    expect(requirement.sextants).toEqual([...SEXTANTS]);
    expect(requirement.drivenBy).toEqual(["LL"]);
  });

  it("updates the moment a score is cleared, so the screen cannot outlive the score", () => {
    const state = run(full(), code(4));
    expect(entryRequirement(state).kind).toBe("full-mouth-6-point");
    const cleared = run(state, { type: "move", by: -1 }, { type: "clear" });
    expect(entryRequirement(cleared).kind).toBe("none");
  });

  it("does not let an unscored sextant lower the requirement", () => {
    // Only the sextants actually scored contribute. An absent sextant is absent.
    const state = run(full(), code(4));
    expect(unscoredSextants(state).length).toBe(5);
    expect(entryRequirement(state).kind).toBe("full-mouth-6-point");
  });
});

// ---------------------------------------------------------------------------
// What may be saved, and what the route is sent
// ---------------------------------------------------------------------------

describe("what may be saved", () => {
  it("is not complete while a scorable sextant has no reading", () => {
    const state = run(full(), code(0), code(0));
    expect(isComplete(state)).toBe(false);
    const refusal = saveRefusal(state);
    expect(refusal).toBeTruthy();
    expect(refusal).toContain(SEXTANT_LABEL.UL);
    expect(refusal).toContain(SEXTANT_LABEL.LL);
  });

  it("is complete once every sextant either holds a score or says why it cannot", () => {
    const state = run(crippledUpperRight(), code(0), code(1), code(2), code(3), code(4));
    expect(unscoredSextants(state)).toEqual([]);
    expect(isComplete(state)).toBe(true);
    expect(saveRefusal(state)).toBeNull();
  });

  it("refuses a probe of other with no note, because that names no probe", () => {
    let state = run(crippledUpperRight(), code(0), code(1), code(2), code(3), code(4));
    state = bpeEntryReducer(state, { type: "probe", probe: "other", note: "  " });
    expect(saveRefusal(state)).toMatch(/probe/i);
    state = bpeEntryReducer(state, { type: "probe", probe: "other", note: "Michigan O" });
    expect(saveRefusal(state)).toBeNull();
  });

  it("sends the route all six sextants, serialised the way the engine writes them", () => {
    // The upper right cannot be scored, so travel is UA, UL, LR, LA, LL. "One
    // star" in the upper anterior, then four plain codes.
    const state = run(crippledUpperRight(), code(1), { type: "furcation" }, code(2), code(3), code(4), code(0));
    const payload = toSavePayload(state);
    expect(Object.keys(payload.scores).sort()).toEqual([...SEXTANTS].sort());
    expect(Object.keys(payload.statuses).sort()).toEqual([...SEXTANTS].sort());
    // The unscorable sextant carries a null and a REASON, never a 0.
    expect(payload.scores.UR).toBeNull();
    expect(payload.statuses.UR).toBe("insufficient-teeth");
    // The star travels as the engine writes it.
    expect(payload.scores.UA).toBe("1*");
    expect(payload.statuses.UA).toBe("scorable");
    expect(payload.probe).toBe("who-621");
    expect(payload.probeNote).toBeNull();
  });

  it("never sends a status of scorable alongside a null score for a sextant it could score", () => {
    // The route refuses that pair, and it is right to: a scorable sextant with no
    // score is an examination that was not finished, and the screen must catch it
    // before the round trip rather than after.
    const state = run(full(), code(0));
    expect(isComplete(state)).toBe(false);
    expect(saveRefusal(state)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Seeding, resetting, and not losing what was typed
// ---------------------------------------------------------------------------

describe("the machine's own bookkeeping", () => {
  it("is not dirty until something is accepted, and clean again once saved", () => {
    expect(full().dirty).toBe(false);
    const typed = run(full(), code(2));
    expect(typed.dirty).toBe(true);
    expect(bpeEntryReducer(typed, { type: "saved" }).dirty).toBe(false);
  });

  it("keeps every score through a failed save, because six called-out numbers are not re-callable", () => {
    const state = run(full(), code(0), code(1), code(2), code(3), code(4), code(0));
    const after = bpeEntryReducer(state, { type: "message", message: "That did not save." });
    expect(SEXTANTS.map((s) => after.scores[s]?.code)).toEqual([0, 1, 2, 3, 4, 0]);
    expect(after.dirty).toBe(true);
  });

  it("bumps the nonce on every accepted action so an identical message is re-announced", () => {
    const one = bpeEntryReducer(full(), code(9));
    const two = bpeEntryReducer(one, code(9));
    expect(two.message).toBe(one.message);
    expect(two.nonce).toBeGreaterThan(one.nonce);
  });

  it("seeds from an existing exam for an amendment, keeping its stars", () => {
    const state = initBpeEntry({
      presentTeeth: BPE_TEETH,
      scores: { UR: { code: 3, furcation: true }, UA: { code: 0, furcation: false } },
    });
    expect(state.scores.UR).toEqual({ code: 3, furcation: true });
    expect(state.scores.UL).toBeNull();
    expect(state.dirty).toBe(false);
    expect(entryRequirement(state).kind).toBe("sextant-6-point");
  });

  it("refuses a seeded score for a sextant that cannot be scored", () => {
    // A stored exam can hold a score for a sextant this mouth can no longer
    // support — teeth are extracted between examinations. It is dropped, and the
    // sextant reads as unscorable rather than carrying a stale number.
    const teeth = BPE_TEETH.filter((t) => !SEXTANT_TEETH.UR.includes(t) || t === 17);
    const state = initBpeEntry({ presentTeeth: teeth, scores: { UR: { code: 4, furcation: false } } });
    expect(state.scores.UR).toBeNull();
    expect(state.statuses.UR).toBe("insufficient-teeth");
  });
});
