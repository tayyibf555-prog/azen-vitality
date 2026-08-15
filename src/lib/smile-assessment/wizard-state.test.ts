// The create wizard's stage machine.
//
// The load-bearing rule is that the DETAILS screen is unreachable without a
// choice behind it - that is the whole difference between the staged wizard and
// the long scrolling form it replaced, and it is what the goal field locks to.
// Everything else here is about what survives a transition and what must not.
//
// Every assertion names the mutation it catches.

import { describe, it, expect } from "vitest";
import { buildScratchFlow, templateForGoal } from "./flow-templates";
import {
  INITIAL_WIZARD,
  initialGoal,
  isDetailsOpen,
  isGalleryOpen,
  isListVisible,
  lockedGoal,
  wizardReducer,
  type TemplateChoice,
  type WizardEvent,
  type WizardState,
} from "./wizard-state";

const TEMPLATE_CHOICE: TemplateChoice = {
  key: "invisalign",
  goal: "invisalign",
  graph: templateForGoal("invisalign").build(),
  source: "template",
};

const SCRATCH_CHOICE: TemplateChoice = {
  key: "scratch",
  goal: null,
  graph: buildScratchFlow(),
  source: "scratch",
};

const AI_CHOICE: TemplateChoice = {
  key: "whitening",
  goal: "whitening",
  graph: templateForGoal("whitening").build(),
  source: "ai",
  note: "Written for this goal.",
};

/** Replay a run of events from the resting state. */
function run(...events: WizardEvent[]): WizardState {
  return events.reduce(wizardReducer, INITIAL_WIZARD);
}

const EVERY_EVENT: WizardEvent[] = [
  { type: "open" },
  { type: "choose", choice: TEMPLATE_CHOICE },
  { type: "back" },
  { type: "cancel" },
  { type: "created" },
];

/* ---------------------------------------------------------------------------
 * One screen at a time.
 * ------------------------------------------------------------------------- */

describe("exactly one screen is on at any moment", () => {
  // MUTATION: let the gallery and the list render together (drop isListVisible
  // and gate the list on something else) and the takeover stops being a takeover.
  it("never has two of list, gallery and details true at once", () => {
    const states: WizardState[] = [
      INITIAL_WIZARD,
      run({ type: "open" }),
      run({ type: "open" }, { type: "choose", choice: TEMPLATE_CHOICE }),
      run({ type: "open" }, { type: "choose", choice: TEMPLATE_CHOICE }, { type: "back" }),
      run({ type: "open" }, { type: "choose", choice: TEMPLATE_CHOICE }, { type: "created" }),
    ];
    for (const state of states) {
      const on = [isListVisible(state), isGalleryOpen(state), isDetailsOpen(state)].filter(Boolean);
      expect(on.length, JSON.stringify(state.stage)).toBe(1);
    }
  });

  it("rests on the list, with nothing chosen", () => {
    expect(INITIAL_WIZARD).toEqual({ stage: "closed", choice: null });
    expect(isListVisible(INITIAL_WIZARD)).toBe(true);
  });

  it("opens onto the gallery", () => {
    const state = run({ type: "open" });
    expect(state.stage).toBe("gallery");
    expect(isGalleryOpen(state)).toBe(true);
  });
});

/* ---------------------------------------------------------------------------
 * THE LOAD-BEARING RULE.
 * ------------------------------------------------------------------------- */

describe("details is unreachable without a choice behind it", () => {
  // MUTATION: drop the `state.stage !== "gallery"` guard on `choose` and any
  // stray choose - including one from a gallery already dismissed - lands on a
  // details screen whose goal has nothing to lock to.
  it("cannot be reached from the resting state, or from details itself", () => {
    expect(run({ type: "choose", choice: TEMPLATE_CHOICE })).toEqual(INITIAL_WIZARD);

    const details = run({ type: "open" }, { type: "choose", choice: TEMPLATE_CHOICE });
    const stale = wizardReducer(details, { type: "choose", choice: AI_CHOICE });
    expect(stale).toBe(details);
    expect(stale.choice?.key).toBe("invisalign");
  });

  // MUTATION: allow `choice: null` onto the details stage and the goal field has
  // nothing to lock to, silently reverting to the old free-for-all form.
  it("always carries a choice whenever details is the screen", () => {
    for (const choice of [TEMPLATE_CHOICE, SCRATCH_CHOICE, AI_CHOICE]) {
      const state = run({ type: "open" }, { type: "choose", choice });
      expect(isDetailsOpen(state)).toBe(true);
      expect(state.choice).not.toBeNull();
      expect(state.choice?.graph.nodes.length).toBeGreaterThan(0);
    }
  });

  // Exhaustive: no run of events, however odd, lands on details with no choice.
  // MUTATION: any relaxation of the choose guard shows up here.
  it("holds across every three-event run of the machine", () => {
    for (const a of EVERY_EVENT) {
      for (const b of EVERY_EVENT) {
        for (const c of EVERY_EVENT) {
          const state = run(a, b, c);
          if (state.stage !== "details") continue;
          expect(state.choice, `${a.type} -> ${b.type} -> ${c.type}`).not.toBeNull();
        }
      }
    }
  });
});

/* ---------------------------------------------------------------------------
 * What survives a transition, and what must not.
 * ------------------------------------------------------------------------- */

describe("going back keeps the choice; leaving clears it", () => {
  // MUTATION: clear the choice on `back` and the gallery reopens with nothing
  // marked, so the owner cannot see what they are changing away from.
  it("returns to the gallery with the chosen card still chosen", () => {
    const state = run({ type: "open" }, { type: "choose", choice: TEMPLATE_CHOICE }, { type: "back" });
    expect(state.stage).toBe("gallery");
    expect(state.choice?.key).toBe("invisalign");
  });

  it("can be changed after going back, and the new choice wins", () => {
    const state = run(
      { type: "open" },
      { type: "choose", choice: TEMPLATE_CHOICE },
      { type: "back" },
      { type: "choose", choice: AI_CHOICE },
    );
    expect(state.stage).toBe("details");
    expect(state.choice?.key).toBe("whitening");
    expect(state.choice?.source).toBe("ai");
  });

  // MUTATION: carry `state.choice` through `open` instead of clearing it. Note
  // the assertion has to open from a stage that still HOLDS a choice to bite:
  // opening after a cancel passes either way, because cancel already cleared it.
  // That is the whole reason this is asserted at the reducer rather than only
  // through a plausible run - "open starts clean" must not depend on some other
  // event having tidied up first.
  it("starts clean on every open, whatever was on screen before", () => {
    const abandoned = run(
      { type: "open" },
      { type: "choose", choice: TEMPLATE_CHOICE },
      { type: "cancel" },
      { type: "open" },
    );
    expect(abandoned).toEqual({ stage: "gallery", choice: null });

    // Straight from a details screen that is still holding a choice.
    const holding = run({ type: "open" }, { type: "choose", choice: TEMPLATE_CHOICE });
    expect(holding.choice).not.toBeNull();
    expect(wizardReducer(holding, { type: "open" })).toEqual({ stage: "gallery", choice: null });

    // And from a gallery re-opened via the back-link, which deliberately keeps one.
    const backWithChoice = wizardReducer(holding, { type: "back" });
    expect(backWithChoice.choice).not.toBeNull();
    expect(wizardReducer(backWithChoice, { type: "open" })).toEqual({
      stage: "gallery",
      choice: null,
    });
  });

  // MUTATION: leave the choice in place on `created` and the next "New
  // assessment" starts on the funnel of the one just made.
  it("clears everything on cancel and on a successful create", () => {
    const base = run({ type: "open" }, { type: "choose", choice: TEMPLATE_CHOICE });
    expect(wizardReducer(base, { type: "cancel" })).toEqual(INITIAL_WIZARD);
    expect(wizardReducer(base, { type: "created" })).toEqual(INITIAL_WIZARD);
  });

  // MUTATION: throw on an out-of-stage event and a stray click takes the page
  // down; return a fresh object and React re-renders on every no-op.
  it("returns the same state object, untouched, for an event that makes no sense", () => {
    const gallery = run({ type: "open" });
    expect(wizardReducer(gallery, { type: "back" })).toBe(gallery);
    expect(wizardReducer(INITIAL_WIZARD, { type: "back" })).toBe(INITIAL_WIZARD);
    expect(
      wizardReducer(INITIAL_WIZARD, { type: "nonsense" } as unknown as WizardEvent),
    ).toBe(INITIAL_WIZARD);
  });

  // MUTATION: mutate `state` in place instead of returning a new object and the
  // reducer stops being safe to run under React's double-invoke.
  it("never mutates the state it was handed", () => {
    const before = run({ type: "open" }, { type: "choose", choice: TEMPLATE_CHOICE });
    const snapshot = JSON.stringify(before);
    wizardReducer(before, { type: "back" });
    wizardReducer(before, { type: "cancel" });
    wizardReducer(before, { type: "created" });
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

/* ---------------------------------------------------------------------------
 * The goal lock.
 * ------------------------------------------------------------------------- */

describe("the goal is locked to the template's goal, and only then", () => {
  // MUTATION: return null always and the field unlocks, letting an Invisalign
  // funnel be attached to a whitening assessment - the first screen then asks
  // the wrong question.
  it("locks to a template's goal, and to an AI funnel's goal", () => {
    expect(lockedGoal(run({ type: "open" }, { type: "choose", choice: TEMPLATE_CHOICE }))).toBe(
      "invisalign",
    );
    expect(lockedGoal(run({ type: "open" }, { type: "choose", choice: AI_CHOICE }))).toBe(
      "whitening",
    );
  });

  // MUTATION: lock on scratch too and a treatment-agnostic funnel is pinned to
  // whichever goal happened to be first in the catalogue.
  it("does not lock a funnel built from scratch, which has no goal", () => {
    const state = run({ type: "open" }, { type: "choose", choice: SCRATCH_CHOICE });
    expect(isDetailsOpen(state)).toBe(true);
    expect(lockedGoal(state)).toBeNull();
  });

  it("locks nothing while there is no choice", () => {
    expect(lockedGoal(INITIAL_WIZARD)).toBeNull();
    expect(lockedGoal(run({ type: "open" }))).toBeNull();
  });

  // MUTATION: ignore the fallback and a scratch run opens the form on an empty
  // goal, which the create POST would reject.
  it("opens the form on the locked goal, or the caller's default when free", () => {
    expect(initialGoal(run({ type: "open" }, { type: "choose", choice: TEMPLATE_CHOICE }), "general")).toBe(
      "invisalign",
    );
    expect(initialGoal(run({ type: "open" }, { type: "choose", choice: SCRATCH_CHOICE }), "general")).toBe(
      "general",
    );
    expect(initialGoal(INITIAL_WIZARD, "general")).toBe("general");
  });

  // MUTATION: drop the note from TemplateChoice and a degraded AI write becomes
  // invisible - the gallery that raised it is gone by the time it would be read.
  it("carries a degradation note through to the screen that shows it", () => {
    const state = run({ type: "open" }, { type: "choose", choice: AI_CHOICE });
    expect(state.choice?.note).toBe("Written for this goal.");
    // And it survives a look back at the gallery and a re-pick of the same card.
    const backAndForth = wizardReducer(
      wizardReducer(state, { type: "back" }),
      { type: "choose", choice: AI_CHOICE },
    );
    expect(backAndForth.choice?.note).toBe("Written for this goal.");
  });
});
