// ===========================================================================
// THE BPE ENTRY MACHINE.
//
// PURE. No React, no DOM, no I/O, no clock — every time value the caller needs is
// the caller's. It lives in a .ts file rather than beside its component because
// this repo's vitest collects `src/**/*.test.ts` in a node environment and cannot
// test a .tsx at all, and the four things below are exactly the things that must
// be tested rather than eyeballed: the travel order, the skip rule, the `*`
// toggle and the refusal of anything that is not a BPE code.
//
// -- IT TAKES VALUES AND COMMANDS, NEVER KEYSTROKES -----------------------
//
// `{ type: "code", code: 3 }` means "a three in the sextant at the cursor, then
// move on", and it does not care whether a finger, a barcode scanner or a
// transcript of an assistant reading numbers aloud produced the 3. PERIO.md §4
// says voice entry is the real prize and that the machine must be designed to be
// driven by a stream of numbers; the keyboard handler in bpe-entry.tsx is a thin
// adapter over this seam and holds no rule of its own.
//
// -- THE TRAVEL ORDER IS THE CLINICAL ORDER --------------------------------
//
// UR, UA, UL, then LR, LA, LL. That is the order a clinician probes and calls
// out, and it is read from bpe.ts's own SEXTANTS rather than restated here: a
// second table of the sextants is precisely how two screens come to disagree
// about which box is which. Any other order forces the clinician to translate
// between what they just said and where the cursor is, at speed, with their eyes
// in someone's mouth.
//
// -- A SEXTANT THAT CANNOT BE SCORED CAN NEVER RECEIVE A SCORE -------------
//
// A sextant needs MIN_TEETH_PER_SEXTANT qualifying teeth; one that has fewer is
// recorded with the adjacent sextant instead (PERIO.md §3.1). That is a DISTINCT
// STATE and never a zero — code 0 is a positive claim of health, "not scorable"
// is the absence of a claim, and collapsing the two writes a missed examination
// down as a clean result (CHARTING.md §6.3, "false completeness").
//
// So such a sextant is left out of the travel order, AND the reducer refuses a
// code aimed at it even with the cursor forged onto it. The travel order alone
// would be a convention; the refusal is the guarantee.
//
// -- WHAT THE MACHINE WILL NOT DECIDE ---------------------------------------
//
// It never invents a mouth. With no `presentTeeth` supplied the platform does not
// know the dentition, so every sextant opens SCORABLE — assuming teeth are
// missing would skip a sextant the clinician can see and can score. In that state
// only, a clinician may declare a sextant unscorable, because they are the one
// looking at the patient. Where the dentition IS known the chart is authoritative
// in both directions and the declaration is refused.
//
// And it never re-expresses a clinical rule. Sextant membership, qualification,
// what a code 3 or a code 4 demands and how a score is written all come from
// bpe.ts. This file owns a cursor, six boxes and the sentences about them.
// ===========================================================================

import {
  ADJACENT_SEXTANT,
  BPE_TEETH,
  DEFAULT_PROBE,
  MIN_TEETH_PER_SEXTANT,
  SEXTANTS,
  SEXTANT_LABEL,
  chartingRequirement,
  isBpeCode,
  qualifySextants,
  serialiseBpeScore,
} from "./bpe";
import type {
  BpeCode,
  BpeScore,
  ChartingRequirement,
  PerioProbe,
  SextantId,
  SextantQualificationMap,
  SextantStatus,
} from "./types";

/** The two ways a sextant can fail to qualify. Never a code, never a blank. */
export type UnscorableStatus = Exclude<SextantStatus, "scorable">;

export interface BpeEntryState {
  /** The engine's own answer about this mouth. Read-only within the machine. */
  qualification: SextantQualificationMap;
  /**
   * Whether the platform actually knows which teeth are present.
   *
   * False when no dentition was supplied, which is the ordinary case today: the
   * record does not carry a tooth list. It is the one thing that decides whether
   * a clinician may declare a sextant unscorable — see the header.
   */
  dentitionKnown: boolean;
  scores: Record<SextantId, BpeScore | null>;
  /** What each sextant currently claims about itself. Seeded from the engine's
   *  qualification and only ever changed by an explicit declaration. */
  statuses: Record<SextantId, SextantStatus>;
  /** The sextant the next number lands in. Null when none can be scored. */
  cursor: SextantId | null;
  /**
   * The sextant the most recent code landed in, so a `*` reaches the number just
   * given rather than the empty box the cursor has moved on to.
   *
   * A BPE IS CALLED OUT AS "THREE STAR", one utterance, and the code advances the
   * cursor the moment it is accepted. Without this the star would arrive at the
   * next sextant, which holds no code, and be refused — so the clinician would
   * have to step back for every furcation. Cleared by any navigation: once the
   * cursor has been moved deliberately, the star means the cursor and nothing
   * else.
   */
  lastScored: SextantId | null;
  probe: PerioProbe;
  /** Free text, required when the probe is "other" — otherwise "other" names
   *  no probe, and the 3.5–5.5mm band that separates a 3 from a 4 is a property
   *  of the probe rather than of the mouth. */
  probeNote: string;
  /** A whole sentence for the screen and the live region, or null. */
  message: string | null;
  /** Bumped on every action so two identical consecutive announcements are
   *  distinct states and the second is re-announced rather than going quiet. */
  nonce: number;
  /** Something has been entered that is not on the patient's record. */
  dirty: boolean;
}

export type BpeEntryAction =
  /** THE STREAM SEAM. A BPE code at the cursor, then advance. Takes a `number`
   *  rather than a BpeCode on purpose: the whole point is that it validates. */
  | { type: "code"; code: number }
  /** Toggle furcation involvement on the score already at the cursor. */
  | { type: "furcation" }
  | { type: "clear" }
  | { type: "move"; by: number }
  | { type: "moveTo"; sextant: SextantId }
  /**
   * A clinician's own statement that a sextant cannot be scored.
   *
   * IT NAMES THE SEXTANT, and the sextant is not optional. This action used to
   * act on the cursor, and the control that dispatches it sits on ONE BOX — so
   * pressing "cannot be scored" under the upper left declared whichever sextant
   * the cursor happened to be resting on, wiped the score already in it, and
   * changed the charting requirement that score had created. A declaration is
   * about a sextant a clinician is looking at, never about where a cursor is.
   */
  | { type: "declareUnscorable"; sextant: SextantId; status: UnscorableStatus }
  | { type: "undeclare"; sextant: SextantId }
  | { type: "probe"; probe: PerioProbe; note?: string }
  /** A sentence from outside the machine — a save that failed, most often. It
   *  changes nothing that was typed. */
  | { type: "message"; message: string | null }
  | { type: "saved" };

// ---------------------------------------------------------------------------
// Building one
// ---------------------------------------------------------------------------

export interface BpeEntryInit {
  /** FDI numbers of the teeth present. Omit when the platform does not know. */
  presentTeeth?: readonly number[];
  /** Teeth carrying implants. An implant is not a qualifying tooth. */
  implantTeeth?: readonly number[];
  probe?: PerioProbe;
  probeNote?: string;
  /** Seed for an amendment or a re-open. A score for a sextant this mouth can no
   *  longer support is DROPPED rather than carried forward. */
  scores?: Partial<Record<SextantId, BpeScore | null>>;
}

export function initBpeEntry(init: BpeEntryInit): BpeEntryState {
  const dentitionKnown = Array.isArray(init.presentTeeth);
  // With no dentition supplied, qualify against the full BPE tooth set: every
  // sextant opens scorable, because the machine must not invent missing teeth.
  const qualification = qualifySextants(init.presentTeeth ?? BPE_TEETH, {
    implantTeeth: init.implantTeeth,
  });

  const scores = {} as Record<SextantId, BpeScore | null>;
  const statuses = {} as Record<SextantId, SextantStatus>;
  for (const sextant of SEXTANTS) {
    const status = qualification[sextant].status;
    statuses[sextant] = status;
    const seeded = init.scores?.[sextant] ?? null;
    scores[sextant] = status === "scorable" && seeded ? { ...seeded } : null;
  }

  const state: BpeEntryState = {
    qualification,
    dentitionKnown,
    scores,
    statuses,
    cursor: null,
    lastScored: null,
    probe: init.probe ?? DEFAULT_PROBE,
    probeNote: init.probeNote ?? "",
    message: null,
    nonce: 0,
    dirty: false,
  };
  return { ...state, cursor: firstScorable(state) };
}

// ---------------------------------------------------------------------------
// Reading the state. Everything derivable is derived — nothing about the
// requirement, the travel order or the completeness of the exam is stored, so a
// screen cannot print a consequence that disagrees with the scores beside it.
// ---------------------------------------------------------------------------

/** Whether a number may be written into this sextant at all. */
export function canScore(state: BpeEntryState, sextant: SextantId): boolean {
  return state.statuses[sextant] === "scorable";
}

/** THE ORDER OF TRAVEL: the engine's own sextant order, minus the ones that
 *  cannot hold a score. Never re-sorted, never reversed. */
export function travelOrder(state: BpeEntryState): SextantId[] {
  return SEXTANTS.filter((sextant) => canScore(state, sextant));
}

export function cursorSextant(state: BpeEntryState): SextantId | null {
  return state.cursor;
}

function firstScorable(state: BpeEntryState): SextantId | null {
  return travelOrder(state)[0] ?? null;
}

/** Sextants that could be scored and have not been. What stands between the
 *  clinician and a saveable examination. */
export function unscoredSextants(state: BpeEntryState): SextantId[] {
  return SEXTANTS.filter((sextant) => canScore(state, sextant) && state.scores[sextant] === null);
}

export function isComplete(state: BpeEntryState): boolean {
  return unscoredSextants(state).length === 0;
}

/** THE ENGINE'S ANSWER, not this file's. A 3 demands a six-point chart of that
 *  sextant after initial therapy; a 4 demands full-mouth from the outset; the
 *  sentence explaining which and why is written by chartingRequirement(). */
export function entryRequirement(state: BpeEntryState): ChartingRequirement {
  return chartingRequirement(state.scores);
}

/**
 * WHY THIS SEXTANT CANNOT BE SCORED, as a whole sentence, naming where its teeth
 * are recorded instead — or null when it can be scored.
 *
 * The destination comes from the engine's own reassignments where they exist, and
 * falls back to ADJACENT_SEXTANT otherwise. ADJACENT_SEXTANT is deliberately null
 * for the two anterior sextants: they have a neighbour on each side of the
 * midline, so the answer is only ever per tooth, and naming one end would put a
 * reading on the wrong side of the mouth. Where the per-tooth answer is
 * unavailable the sentence declines to name a side rather than guessing.
 */
export function skipReason(state: BpeEntryState, sextant: SextantId): string | null {
  if (canScore(state, sextant)) return null;
  const label = SEXTANT_LABEL[sextant];

  if (state.statuses[sextant] === "no-teeth") {
    return (
      `The ${label} sextant has no teeth, so there is nothing to examine and nothing to score. ` +
      "That is not a score of 0."
    );
  }

  const head =
    `The ${label} sextant has fewer than ${MIN_TEETH_PER_SEXTANT} qualifying teeth, so it cannot be ` +
    "scored — that is the absence of a score, never a 0.";

  const destinations = [
    ...new Set(state.qualification[sextant].reassignments.map((r) => r.to)),
  ];
  const named = destinations.filter((d): d is SextantId => d !== null);
  const stranded = destinations.some((d) => d === null);

  if (named.length > 0) {
    const where = `Its remaining teeth are recorded with the ${listLabels(named)} sextant${named.length === 1 ? "" : "s"}.`;
    return stranded
      ? `${head} ${where} One or more could not be recorded anywhere, because the adjacent sextant cannot be scored either.`
      : `${head} ${where}`;
  }
  if (stranded) {
    return (
      `${head} Its remaining teeth could not be recorded anywhere: the adjacent sextant cannot be ` +
      "scored either, so those readings are held nowhere on this grid."
    );
  }

  const fixed = ADJACENT_SEXTANT[sextant];
  return fixed
    ? `${head} Its remaining teeth are recorded with the ${SEXTANT_LABEL[fixed]} sextant.`
    : `${head} Its remaining teeth are recorded with the adjacent sextant on that tooth's own side of the midline.`;
}

/**
 * The one sentence standing between this examination and the record, or null when
 * nothing is.
 *
 * A BPE RECORDS ALL SIX SEXTANTS. The route refuses a scorable sextant with no
 * score, and it is right to: a half-typed BPE stored as a whole one reads to the
 * next clinician as an examination that found nothing there. Caught here so it is
 * a sentence beside the button rather than a rejection after the round trip.
 */
export function saveRefusal(state: BpeEntryState): string | null {
  if (travelOrder(state).length === 0) {
    return (
      "No sextant in this mouth can be scored, so there is no BPE to record. Every sextant has " +
      `fewer than ${MIN_TEETH_PER_SEXTANT} qualifying teeth.`
    );
  }
  const missing = unscoredSextants(state);
  if (missing.length > 0) {
    return (
      `A BPE records all six sextants, and the ${listLabels(missing)} ` +
      `${missing.length === 1 ? "sextant has" : "sextants have"} no score yet. ` +
      "An unscored sextant must never be stored as a 0."
    );
  }
  if (state.probe === "other" && !state.probeNote.trim()) {
    return 'A probe of "other" has to say which probe was used: the 3.5–5.5mm band that separates a code 3 from a code 4 is a property of the probe, not of the mouth.';
  }
  return null;
}

/**
 * The body POST /api/perio/bpe's grid path expects, and nothing more.
 *
 * All six sextants, every time. A score is written by the ENGINE's own writer, so
 * "3" and "3*" come out of serialiseBpeScore rather than out of string
 * concatenation here; a sextant that cannot be scored travels as a null and a
 * REASON, which is what stops the server storing it as a 0.
 */
export function toSavePayload(state: BpeEntryState): {
  scores: Record<SextantId, string | null>;
  statuses: Record<SextantId, SextantStatus>;
  probe: PerioProbe;
  probeNote: string | null;
} {
  const scores = {} as Record<SextantId, string | null>;
  const statuses = {} as Record<SextantId, SextantStatus>;
  for (const sextant of SEXTANTS) {
    const score = canScore(state, sextant) ? state.scores[sextant] : null;
    scores[sextant] = score ? serialiseBpeScore(score) : null;
    statuses[sextant] = state.statuses[sextant];
  }
  return {
    scores,
    statuses,
    probe: state.probe,
    probeNote: state.probe === "other" ? state.probeNote.trim() || null : null,
  };
}

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

function bump(state: BpeEntryState, message: string | null): BpeEntryState {
  return { ...state, nonce: state.nonce + 1, message };
}

/** The refusal a code aimed at an unscorable sextant earns. Names the sextant and
 *  where its teeth actually go, because "refused" on its own leaves a clinician
 *  looking for a reading they gave. */
function refuseUnscorable(state: BpeEntryState, sextant: SextantId): BpeEntryState {
  return bump(state, skipReason(state, sextant));
}

function advance(state: BpeEntryState): BpeEntryState {
  const order = travelOrder(state);
  const index = state.cursor === null ? -1 : order.indexOf(state.cursor);
  if (index < 0) return { ...state, cursor: order[0] ?? null };
  const next = order[index + 1];
  if (next === undefined) {
    return { ...state, message: "That is the last sextant of this BPE." };
  }
  return { ...state, cursor: next };
}

export function bpeEntryReducer(state: BpeEntryState, action: BpeEntryAction): BpeEntryState {
  switch (action.type) {
    case "code": {
      const sextant = state.cursor;
      if (sextant === null) {
        return bump(
          state,
          "No sextant in this mouth can be scored, so there is nowhere for that number to go.",
        );
      }
      // THE GUARANTEE, not the convention. travelOrder() already keeps the cursor
      // off an unscorable sextant; this is what holds if anything ever puts it
      // there anyway. A 0 written here is a claim of health nobody made.
      if (!canScore(state, sextant)) return refuseUnscorable(state, sextant);
      if (!isBpeCode(action.code)) {
        // REFUSED, NOT CLAMPED. A 5 clamped to a 4 is a full-mouth six-point chart
        // nobody asked for; a 5 dropped in silence is a sextant nobody scored.
        return bump(
          state,
          `A BPE code is 0, 1, 2, 3 or 4 — codes run 0 to 4, with * added for furcation. ` +
            `"${String(action.code)}" was not accepted, and the ${SEXTANT_LABEL[sextant]} sextant is unchanged.`,
        );
      }
      const code = action.code as BpeCode;
      const withScore: BpeEntryState = {
        ...state,
        scores: { ...state.scores, [sextant]: { code, furcation: false } },
        lastScored: sextant,
        dirty: true,
        nonce: state.nonce + 1,
        message: null,
      };
      return advance(withScore);
    }

    case "furcation": {
      // THE CURSOR FIRST, THEN THE NUMBER JUST GIVEN. See `lastScored`: a BPE is
      // spoken as "three star", and the 3 has already moved the cursor on by the
      // time the star arrives.
      const target = furcationTarget(state);
      if (target === null) {
        const at = state.cursor;
        if (at !== null && !canScore(state, at)) return refuseUnscorable(state, at);
        // The star is ADDITIVE — it sits on a code, it is not a code. bpe.ts says
        // so, and parseBpeScore will not read a bare "*".
        return bump(
          state,
          at === null
            ? "There is no score for a furcation mark to sit on."
            : `Furcation involvement is recorded on top of a code, so score the ${SEXTANT_LABEL[at]} sextant first. ` +
                "A * on its own is not a BPE score.",
        );
      }
      const score = state.scores[target]!;
      // NO ADVANCE. The star modifies a number already given, so moving on would
      // put the next reading in the wrong sextant.
      return {
        ...state,
        scores: { ...state.scores, [target]: { code: score.code, furcation: !score.furcation } },
        dirty: true,
        nonce: state.nonce + 1,
        message: null,
      };
    }

    case "clear": {
      const sextant = state.cursor;
      if (sextant === null) return state;
      if (!canScore(state, sextant)) return refuseUnscorable(state, sextant);
      if (state.scores[sextant] === null) return bump(state, null);
      // A CLEARED BOX IS NOT A STATUS. The sextant stays scorable and unscored,
      // which is the state the save refuses — not a claim about the dentition.
      return {
        ...state,
        scores: { ...state.scores, [sextant]: null },
        lastScored: state.lastScored === sextant ? null : state.lastScored,
        dirty: true,
        nonce: state.nonce + 1,
        message: `The ${SEXTANT_LABEL[sextant]} sextant is now unscored. That is not a 0 — it still needs a reading.`,
      };
    }

    case "move": {
      const order = travelOrder(state);
      if (order.length === 0) return { ...state, cursor: null };
      const from = state.cursor === null ? 0 : order.indexOf(state.cursor);
      // A cursor that is not in the travel order (it was on a sextant that has
      // just been declared unscorable) recovers to the first scorable one rather
      // than to an arbitrary neighbour.
      const base = from < 0 ? 0 : from + action.by;
      const index = Math.max(0, Math.min(order.length - 1, base));
      // lastScored is dropped: once the cursor has been moved deliberately, a
      // star means the sextant under the cursor and nothing else.
      return { ...state, cursor: order[index], lastScored: null, message: null };
    }

    case "moveTo": {
      if (!canScore(state, action.sextant)) return refuseUnscorable(state, action.sextant);
      return { ...state, cursor: action.sextant, lastScored: null, message: null };
    }

    case "declareUnscorable": {
      const sextant = action.sextant;
      if (state.dentitionKnown) {
        // The chart already answers the question, in both directions. A clinician
        // cannot type a sextant out of existence any more than into it.
        const present = state.qualification[sextant].presentTeeth;
        return bump(
          state,
          `This record lists ${present.length} qualifying ${present.length === 1 ? "tooth" : "teeth"} ` +
            `in the ${SEXTANT_LABEL[sextant]} sextant (${present.join(", ") || "none"}), so whether it can be ` +
            "scored is settled by the chart rather than typed here. Correct the chart if it is wrong.",
        );
      }
      if (!canScore(state, sextant)) return bump(state, skipReason(state, sextant));
      return {
        ...state,
        // The score goes with it: a sextant cannot both hold a reading and say it
        // could not be read.
        scores: { ...state.scores, [sextant]: null },
        statuses: { ...state.statuses, [sextant]: action.status },
        // ONLY THE CURSOR THAT WAS STANDING HERE MOVES. Declaring some other
        // sextant must not relocate a clinician mid-examination.
        cursor:
          state.cursor === sextant ? nextAfterLeaving(state, sextant, action.status) : state.cursor,
        lastScored: state.lastScored === sextant ? null : state.lastScored,
        dirty: true,
        nonce: state.nonce + 1,
        message: skipReasonFor(state, sextant, action.status),
      };
    }

    case "undeclare": {
      const sextant = action.sextant;
      if (state.dentitionKnown) return bump(state, null);
      if (state.qualification[sextant].status !== "scorable") {
        // The engine's own answer stands. Only a clinician's own declaration is
        // reversible here.
        return bump(state, skipReason(state, sextant));
      }
      // Nothing to take back. Saying so silently beats announcing that a sextant
      // "can be scored again" when nobody ever said it could not.
      if (state.statuses[sextant] === "scorable") return bump(state, null);
      return {
        ...state,
        statuses: { ...state.statuses, [sextant]: "scorable" },
        // A sextant that has just become scorable is where the cursor goes when
        // there was nowhere for it to be.
        cursor: state.cursor ?? sextant,
        dirty: true,
        nonce: state.nonce + 1,
        message: `The ${SEXTANT_LABEL[sextant]} sextant can be scored again, and has no reading yet.`,
      };
    }

    case "probe":
      return {
        ...state,
        probe: action.probe,
        probeNote: action.note ?? (action.probe === "other" ? state.probeNote : ""),
        dirty: state.dirty,
        nonce: state.nonce + 1,
        message: null,
      };

    case "message":
      // NOTHING TYPED IS TOUCHED. A failed save must keep six numbers a clinician
      // has just called out; losing them is worse than not offering to save.
      return bump(state, action.message);

    case "saved":
      return { ...state, dirty: false, nonce: state.nonce + 1, message: null };

    default:
      return state;
  }
}

/**
 * Which sextant a `*` marks: the one under the cursor if it holds a score, else
 * the one the last code landed in. Null when neither can take it.
 *
 * An unscorable sextant is never a target under either branch — the star is a
 * finding recorded AT a sextant, and a sextant that cannot hold a code cannot
 * hold a finding either.
 */
function furcationTarget(state: BpeEntryState): SextantId | null {
  const at = state.cursor;
  if (at !== null && canScore(state, at) && state.scores[at]) return at;
  const last = state.lastScored;
  if (last !== null && canScore(state, last) && state.scores[last]) return last;
  return null;
}

/** Where the cursor goes when the sextant it was on stops being scorable. */
function nextAfterLeaving(
  state: BpeEntryState,
  sextant: SextantId,
  status: UnscorableStatus,
): SextantId | null {
  const after: BpeEntryState = {
    ...state,
    statuses: { ...state.statuses, [sextant]: status },
  };
  const order = travelOrder(after);
  if (order.length === 0) return null;
  const index = SEXTANTS.indexOf(sextant);
  return order.find((s) => SEXTANTS.indexOf(s) > index) ?? order[order.length - 1];
}

/** skipReason() for a status that is about to be applied. */
function skipReasonFor(
  state: BpeEntryState,
  sextant: SextantId,
  status: UnscorableStatus,
): string | null {
  return skipReason({ ...state, statuses: { ...state.statuses, [sextant]: status } }, sextant);
}

/** "the upper right and upper anterior". Sentence-shaped: these labels land
 *  inside prose, and the labels themselves are the engine's. */
function listLabels(sextants: readonly SextantId[]): string {
  const labels = sextants.map((s) => SEXTANT_LABEL[s]);
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}
