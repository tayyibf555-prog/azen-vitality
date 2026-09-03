// ===========================================================================
// WHAT TO DO FIRST, PER SURFACE — written once, printed everywhere.
//
// A module that has never been used has to say the same thing in two places: on
// its own page, where somebody has arrived with nothing on screen, and in the
// Operating system band on Home, where somebody is deciding whether to go there
// at all. Those two sentences were always going to drift, and a drifted pair is
// worse than either sentence alone: the band promises one first step and the
// page asks for another.
//
// So there is one sentence and both surfaces read it. The band prints it under a
// switched-off or empty module; the module's own empty state prints it in the
// place a table would be.
//
// PURE, AND DELIBERATELY FREE OF EVERY OTHER REGISTRY. This module is imported
// by CLIENT components (the equipment workspace, the IT desk workspace, the
// pre-visit workspace), so it must not drag the agent roster or the systems
// catalog into a browser bundle. It is strings and nothing else. The roster-
// derived switch-on vocabulary lives next door in `vocabulary.ts`, which is
// server-side only for exactly that reason.
//
// TONE (PRODUCT.md): British English, plain, calm, specific. Say what to do.
// No encouragement, no exclamation marks, and the practice's own vocabulary —
// "the register", "the question lists", "your IT contact" — never a slug.
// ===========================================================================

export interface FirstStep {
  /** The surface this belongs to. A CLIENT_NAV slug, or a panel key for a panel. */
  key: string;
  /** What the practice calls it. Never a slug, never an internal name. */
  surface: string;
  /** The imperative first step. One sentence, an action, no preamble. */
  step: string;
}

/**
 * Keyed by nav slug where the surface is a module, and by a panel key where it
 * is a panel inside one (the co-pilot's approved sources).
 */
export const FIRST_STEPS: Record<string, FirstStep> = {
  equipment: {
    key: "equipment",
    surface: "Equipment",
    step:
      "Import the register you already keep for CQC as a spreadsheet, or add your first machine by hand. " +
      "Upload each machine's manual against it and the desk can answer from them.",
  },
  "it-desk": {
    key: "it-desk",
    surface: "IT desk",
    step:
      "Add the practice's IT contact — the person or company a problem goes to when the playbooks run out — " +
      "then switch the desk on.",
  },
  "pre-visit-triage": {
    key: "pre-visit-triage",
    surface: "Pre-visit questions",
    step:
      "Review the two question lists and edit anything you would not ask, then switch the system on. " +
      "Nothing is sent to a patient until you do.",
  },
  "dentally-write-back": {
    key: "dentally-write-back",
    surface: "Dentally write-back",
    step:
      "Read the Dentally sync tab first: it lists every write this platform has held back. " +
      "Switch write-back on once the write key is in place and you are happy with what is waiting.",
  },
  authorities: {
    key: "authorities",
    surface: "Approved sources",
    step:
      "Add the first source your practice trusts — a guideline, a policy, a manufacturer's instructions — " +
      "and the co-pilot will name it when it leans on it. With none added it answers from your own practice data only.",
  },
};

/** The first step for a surface, or null where none is written. */
export function firstStepFor(key: string): FirstStep | null {
  return FIRST_STEPS[key] ?? null;
}
