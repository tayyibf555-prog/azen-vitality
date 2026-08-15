// THE CREATE WIZARD'S STAGE MACHINE.
//
// One screen at a time: the templates gallery, then the details, then the funnel
// on a canvas. The rules about WHICH screen is on and what carries between them
// live here rather than in a pile of booleans inside the panel, for the usual
// reason - vitest collects no .tsx (vitest.config.ts:4), so a transition written
// in JSX is a transition nothing can hold.
//
// THE ONE RULE THAT IS LOAD-BEARING: the details screen is unreachable without a
// choice. The whole point of the rebuild is that an owner picks a starting point
// FIRST and then fills in a short form about it - a details screen with no choice
// behind it is the old one-long-scroll form wearing a new hat, and its goal field
// would have nothing to lock to.
//
// WHAT IS DELIBERATELY NOT HERE: the create POST. Choosing a template does not
// create anything; it only decides what the details screen is about, and the
// unchanged POST still happens from there. The wizard cannot fork the create path
// because it does not know about it.
//
// PURE: no React, no I/O, no barrel. FlowGraph is a type-only import.

import type { FlowGraph } from "./flow";

export type TemplateSource = "template" | "scratch" | "ai";

/**
 * What the owner picked on the gallery, and the funnel it implies.
 *
 * Declared HERE rather than in the gallery component so the stage machine can be
 * typed against it without importing React - and so the panel and the gallery
 * agree on one shape rather than two that drift.
 */
export interface TemplateChoice {
  /** Template key, or SCRATCH_FLOW_KEY, or the goal for an AI-written funnel. */
  key: string;
  /** The goal this choice implies. Null for Start From Scratch. */
  goal: string | null;
  graph: FlowGraph;
  source: TemplateSource;
  /**
   * Shown on the details screen when something degraded on the way here - an AI
   * write that fell back to a starter, most often. It travels WITH the choice
   * because the stage it was raised on is gone by the time it is read, and a
   * degradation the owner never sees is a degradation they cannot act on.
   */
  note?: string;
}

// ---------------------------------------------------------------------------
// Stages.
// ---------------------------------------------------------------------------

/**
 * - closed:  the list of assessments; nothing being created.
 * - gallery: the templates takeover.
 * - details: the short form about the chosen starting point.
 *
 * The canvas is not a stage. It belongs to the campaign that now exists, opens on
 * its card, and is reached by finishing the wizard rather than by moving within
 * it (see CREATED below).
 */
export type WizardStage = "closed" | "gallery" | "details";

export interface WizardState {
  stage: WizardStage;
  choice: TemplateChoice | null;
}

export const INITIAL_WIZARD: WizardState = { stage: "closed", choice: null };

export type WizardEvent =
  /** "New assessment". Always starts clean. */
  | { type: "open" }
  /** A gallery card, an AI write, or Start From Scratch. */
  | { type: "choose"; choice: TemplateChoice }
  /** "Change template" on the details screen. */
  | { type: "back" }
  /** Cancel, or the X on the gallery. */
  | { type: "cancel" }
  /** The create POST succeeded. */
  | { type: "created" };

/**
 * The whole machine. Deliberately total: an event that makes no sense in the
 * current stage returns the state UNCHANGED rather than throwing, because a
 * thrown error here would take a working page down over a stray click, and every
 * transition is pinned by a test either way.
 */
export function wizardReducer(state: WizardState, event: WizardEvent): WizardState {
  switch (event.type) {
    case "open":
      // Clean every time. Reopening after a cancel must not silently reinstate
      // the funnel that was abandoned - the owner would then create an
      // assessment carrying a starting point they thought they had dropped.
      return { stage: "gallery", choice: null };

    case "choose":
      // Only from the gallery. A choose arriving while the details screen is up
      // is a stale click from a gallery that is no longer on screen.
      if (state.stage !== "gallery") return state;
      return { stage: "details", choice: event.choice };

    case "back":
      // The choice SURVIVES, so the gallery reopens with that card marked and the
      // owner can see what they are changing away from.
      if (state.stage !== "details") return state;
      return { stage: "gallery", choice: state.choice };

    case "cancel":
    case "created":
      return INITIAL_WIZARD;

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// What a stage implies for the form.
// ---------------------------------------------------------------------------

/**
 * The goal the details screen locks to, or null when the owner still picks it.
 *
 * A template IS a goal - its questions branch on the treatment answers that goal
 * implies (flow-templates.ts:174-192). Leaving the field editable would let an
 * owner attach an Invisalign funnel to a whitening assessment and have the very
 * first screen ask the wrong question. So the field is locked and the way to
 * change it is to change the template, which is exactly what the back-link does.
 *
 * Start From Scratch has no goal (its funnel is treatment-agnostic), so it does
 * not lock: there is nothing to disagree with.
 */
export function lockedGoal(state: WizardState): string | null {
  return state.choice?.goal ?? null;
}

/** The goal the details form opens on: the choice's, else the caller's default. */
export function initialGoal(state: WizardState, fallback: string): string {
  return lockedGoal(state) ?? fallback;
}

/** Whether the templates takeover is the thing on screen. */
export function isGalleryOpen(state: WizardState): boolean {
  return state.stage === "gallery";
}

/** Whether the details form is the thing on screen. */
export function isDetailsOpen(state: WizardState): boolean {
  return state.stage === "details";
}

/**
 * Whether the assessment list is on screen. Its own predicate rather than
 * `stage === "closed"` at the call site, so "the wizard hides the list" stays one
 * decision as stages are added.
 */
export function isListVisible(state: WizardState): boolean {
  return state.stage === "closed";
}
