// ===========================================================================
// THE CLICK MECHANIC.
//
//   LEFT click  = chart the FIRST surface.
//   RIGHT click = add a FURTHER surface.
//
// Dentally's own documented mechanic, and the single easiest thing on this
// screen to get wrong. All of it is here, PURE and tested, so tooth.tsx decides
// nothing at all.
//
// THE EVENT SET IS click / contextmenu / auxclick / keydown. NOT pointerdown.
// A pointerdown falls outside intentFromPointer's union, so every left click
// would land on the default branch and nothing would chart. Widening the union
// to accept it is worse: a right click fires pointerdown(button 2) AND
// contextmenu, in that order, and under rule 5 that adds the surface and then
// immediately removes it, so a right click silently does nothing.
//
// WHAT THIS DRIVES: our OWN draft, in our own table, and it is SWITCHED OFF by
// default (see write-gate.ts). Nothing here ever reaches Dentally. Rule 14 is
// the structural guarantee: Dentally's items are not in this state at all, so
// no intent, no bug and no future feature can modify the mirror.
// ===========================================================================

import { isDeciduous, isInArch, isTooth } from "./fdi";
import { canonicaliseSurfaces } from "./surfaces";
import type {
  ChartIntent,
  ChartRejection,
  ChartState,
  DraftEntry,
  Dentition,
  SurfaceId,
} from "./types";

/** `${tooth}:${treatmentCode}`. One entry per treatment per tooth, so a filling
 *  and a crown on the same tooth do not overwrite each other. */
export function draftKey(tooth: number, treatmentCode: string): string {
  return `${tooth}:${treatmentCode}`;
}

export function initialChartState(over: Partial<ChartState> = {}): ChartState {
  return {
    dentition: "permanent",
    activeTreatment: null,
    activeTooth: null,
    activePlanId: null,
    locked: false,
    draftEnabled: false,
    draft: {},
    undo: null,
    lastRejection: null,
    rejectionSeq: 0,
    ...over,
  };
}

export interface PointerLike {
  type: "click" | "contextmenu" | "auxclick";
  button: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

/**
 * A raw event's fields to an intent. Never touches the DOM, so it is testable.
 *
 * THE MACOS TRAP: ctrl+left fires contextmenu AND, in some browsers, a click.
 * Treating that click as "first" would chart and then add in ONE gesture,
 * producing a two-surface finding from a one-surface intent. So it is ignored.
 * cmd+left is the browser's own open-in-new-tab gesture and is ignored for the
 * same reason: it is not a charting gesture.
 */
export function intentFromPointer(e: PointerLike): "first" | "add" | "ignore" {
  if (e.type === "contextmenu") return "add";
  if (e.type === "auxclick") return "ignore";
  if (e.button !== 0) return "ignore";
  if (e.ctrlKey || e.metaKey) return "ignore";
  // The trackpad and keyboard route to a second surface, for anyone without a
  // right button.
  return e.shiftKey ? "add" : "first";
}

export function intentFromKey(e: { key: string; shiftKey?: boolean }): "first" | "add" | "ignore" {
  if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return "ignore";
  return e.shiftKey ? "add" : "first";
}

function reject(
  state: ChartState,
  reason: ChartRejection,
  tooth: number | null,
  surface: SurfaceId | null,
): ChartState {
  // The nonce makes two identical consecutive refusals DIFFERENT states, so the
  // aria-live region announces the second one instead of going quiet.
  const nonce = state.rejectionSeq + 1;
  return { ...state, rejectionSeq: nonce, lastRejection: { reason, tooth, surface, nonce } };
}

/**
 * Why this charting intent cannot proceed, or null.
 *
 * THE ORDER MATTERS and is deliberate: the screen must state the REAL cause. A
 * clinician told "select a treatment first" on a chart whose draft is switched
 * off would select a treatment and click again, and learn nothing.
 */
function refusalFor(state: ChartState, tooth: number): ChartRejection | null {
  if (!state.draftEnabled) return "draft-disabled";
  if (state.locked) return "chart-locked";
  if (state.dentition === "base") return "base-chart-is-read-only";
  if (!isTooth(tooth) || !isInArch(tooth, state.dentition)) return "tooth-not-in-arch";
  if (!state.activeTreatment) return "no-treatment-selected";
  return null;
}

function dentitionOf(tooth: number): DraftEntry["dentition"] {
  // Taken from the TOOTH, never from the current view: on the combined chart
  // both dentitions are drawn at once, and a wrongly stamped entry would
  // reappear on the wrong arch after a hydrate.
  return isDeciduous(tooth) ? "deciduous" : "permanent";
}

function withEntry(
  state: ChartState,
  key: string,
  entry: DraftEntry | null,
  previous: DraftEntry | null,
): ChartState {
  const draft = { ...state.draft };
  if (entry) draft[key] = entry;
  else delete draft[key];
  // One step of undo, holding whatever was displaced. `entry: null` in the undo
  // record means "there was nothing here", so undo removes rather than restores.
  return { ...state, draft, undo: { key, entry: previous }, lastRejection: null };
}

export function chartReducer(state: ChartState, intent: ChartIntent): ChartState {
  switch (intent.kind) {
    case "chart-first": {
      const refusal = refusalFor(state, intent.tooth);
      if (refusal) return reject(state, refusal, intent.tooth, intent.surface);
      const treatment = state.activeTreatment as { code: string; name: string };
      const key = draftKey(intent.tooth, treatment.code);
      const previous = state.draft[key] ?? null;
      // Rule 6: a left click on the single already-charted surface clears the
      // tooth, so a left click is its own undo for the single-surface case.
      if (previous && previous.surfaces.length === 1 && previous.surfaces[0] === intent.surface) {
        return { ...withEntry(state, key, null, previous), activeTooth: intent.tooth };
      }
      // Rule 2: it REPLACES. A left click starts a finding; it does not extend
      // one. Rule 12: whatever it displaced is kept in undo, because otherwise
      // a stray click silently deletes an MOD with no way back.
      const entry: DraftEntry = {
        tooth: intent.tooth,
        surfaces: [intent.surface],
        treatmentCode: treatment.code,
        treatmentName: treatment.name,
        dentition: dentitionOf(intent.tooth),
      };
      return { ...withEntry(state, key, entry, previous), activeTooth: intent.tooth };
    }

    case "chart-add": {
      const refusal = refusalFor(state, intent.tooth);
      if (refusal) return reject(state, refusal, intent.tooth, intent.surface);
      const treatment = state.activeTreatment as { code: string; name: string };
      const key = draftKey(intent.tooth, treatment.code);
      const previous = state.draft[key] ?? null;
      // RULE 3, AND IT IS THE WHOLE SAFETY OF THE MECHANIC. An accidental right
      // click must NEVER chart. Deliberately not treated as a first surface,
      // however convenient that would feel.
      if (!previous) return reject(state, "no-first-surface", intent.tooth, intent.surface);
      const held = previous.surfaces.includes(intent.surface);
      const surfaces = held
        ? previous.surfaces.filter((s) => s !== intent.surface)
        : canonicaliseSurfaces([...previous.surfaces, intent.surface]);
      // Rule 5: removing the last surface deletes the entry rather than leaving
      // a zero-surface ghost that would render as a finding with no location.
      const entry = surfaces.length === 0 ? null : { ...previous, surfaces };
      return { ...withEntry(state, key, entry, previous), activeTooth: intent.tooth };
    }

    case "clear-tooth": {
      const keys = Object.keys(state.draft).filter((k) => state.draft[k].tooth === intent.tooth);
      if (keys.length === 0) return state;
      const draft = { ...state.draft };
      for (const k of keys) delete draft[k];
      // Undo carries one entry, so a tooth holding several treatments is
      // cleared without an undo. Stated rather than hidden: the caller confirms
      // before dispatching this on a multi-treatment tooth.
      const undo = keys.length === 1 ? { key: keys[0], entry: state.draft[keys[0]] } : null;
      return { ...state, draft, undo, lastRejection: null };
    }

    case "undo": {
      if (!state.undo) return state;
      const draft = { ...state.draft };
      if (state.undo.entry) draft[state.undo.key] = state.undo.entry;
      else delete draft[state.undo.key];
      // One step only. Leaving the record in place would let a second Undo
      // re-apply the thing it just took back.
      return { ...state, draft, undo: null };
    }

    case "select-treatment":
      return { ...state, activeTreatment: { code: intent.code, name: intent.name } };

    case "set-dentition": {
      // RULE 8: the other dentition's draft is NEVER discarded. Losing one is
      // how a clinician stops trusting the screen.
      const dentition: Dentition = intent.dentition;
      const activeTooth =
        state.activeTooth !== null && isInArch(state.activeTooth, dentition)
          ? state.activeTooth
          : null;
      return { ...state, dentition, activeTooth };
    }

    case "select-plan":
      return { ...state, activePlanId: intent.planId };

    case "set-locked":
      return { ...state, locked: intent.locked };

    case "hydrate":
      // A server read replaces the base, so a one-step undo taken against the
      // old base would restore an entry the server no longer holds.
      return { ...state, draft: { ...intent.draft }, undo: null };

    default:
      return state;
  }
}

/** Every draft entry as a flat list, newest key order, for the "Planned here"
 *  panel that enumerates the draft IN WORDS beside the chart. A hatched
 *  trapezoid is not a distinction that survives a photocopy. */
export function draftEntries(state: ChartState): DraftEntry[] {
  return Object.keys(state.draft)
    .sort()
    .map((k) => state.draft[k]);
}
