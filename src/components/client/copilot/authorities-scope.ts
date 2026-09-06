// ===========================================================================
// HOW MANY APPROVED SOURCES THE CO-PILOT ACTUALLY LEANS ON, IN THE OWNER'S
// WORDS.
//
// THE DEFECT THIS EXISTS FOR (wave-3d review, 6 September 2026; charter §0
// item 5, ruling W3/9). The panel's collapsed subtitle read
// `${active.length} sources the co-pilot may cite.` over EVERY active
// authority. What reaches the model is bounded: `authoritiesBrief` takes
// `active.slice(0, AUTHORITY_BRIEF_MAX)` — eight — and the co-pilot's own
// active-list read (src/lib/knowledge/repository.ts) orders `created_at`
// ASCENDING, so the eight that survive are the OLDEST and the ones silently
// dropped are the ones the owner added most recently. The
// brief itself is honest ("Showing 8 of 12 approved authorities…"), but that
// sentence is written into the SYSTEM PROMPT and is never shown to anybody.
//
// So the owner listed twelve sources, read "12 sources the co-pilot may cite",
// asked about the fourth one he added — and got an answer that did not know it
// existed. Nothing on the screen could tell him why, and the natural conclusion
// is that the co-pilot is ignoring a source rather than that it was never given
// one. A complete count wearing a predicate the code does not honour is the
// same defect as a truncated count wearing a total's clothes.
//
// A PLAIN MODULE, NOT PART OF THE PANEL, for the reason upload-limits.ts gives
// next door: every decision here has a right and a wrong answer, and a
// decision made inside a React component that only renders after a fetch and a
// click cannot be tested in this suite (node env, `renderToStaticMarkup`, no
// DOM, no click). Out here it is ordinary code with ordinary tests, and the
// bound is IMPORTED from the module that enforces it rather than retyped —
// a number written twice is a number that drifts.
// ===========================================================================
import { AUTHORITY_BRIEF_MAX } from "@/lib/knowledge/authorities";
import type { ApprovedAuthority } from "@/lib/knowledge/types";

/**
 * The active sources, and which of them the co-pilot will actually be handed.
 *
 * THE ORDER IS THE WHOLE OF THE COUPLING, and it is load-bearing twice over.
 * `listAllAuthorities` (this panel's read) and the co-pilot's own active-list
 * read both order `created_at` ASCENDING, and `authoritiesBrief` keeps
 * the FIRST `AUTHORITY_BRIEF_MAX` of the active list. So the rows in scope are
 * the first `AUTHORITY_BRIEF_MAX` active rows in the order the panel already
 * has them — the longest-standing ones. authorities-scope.test.ts reads both
 * repository functions and the brief as TEXT and goes red the day either
 * ordering moves, because a panel marking the wrong eight rows would be worse
 * than a panel marking none.
 *
 * NEITHER NAME IS SPELLED OUT ABOVE, and that is deliberate: gating.test.ts
 * crawls every production file for the co-pilot's active-list reader and pins
 * the reader set to exactly two files, by TEXT. Nothing here reads that list —
 * this module is handed rows the panel already has — so it stays out of the
 * crawl rather than becoming a named exemption that a later edit could hide a
 * real read behind. The test file, which the crawl excludes, names both.
 */
export function authoritiesInScope(rows: readonly ApprovedAuthority[]): {
  active: ApprovedAuthority[];
  /** The ids the brief will carry. */
  inBrief: Set<string>;
  /** True when the list is longer than the model is given. */
  overBound: boolean;
  bound: number;
} {
  const active = rows.filter((r) => r.status === "active");
  return {
    active,
    inBrief: new Set(active.slice(0, AUTHORITY_BRIEF_MAX).map((r) => r.id)),
    overBound: active.length > AUTHORITY_BRIEF_MAX,
    bound: AUTHORITY_BRIEF_MAX,
  };
}

/**
 * The one line under "Approved sources" while the panel is shut.
 *
 * It is the only sentence most owners will ever read about this list, so it
 * says what is in scope rather than what is stored. Under the bound the two are
 * the same sentence and it stays as it was; over the bound it names both
 * numbers, because "12" alone is the figure that misleads and "8" alone would
 * lose the owner's own count.
 */
export function authoritiesSubtitle(activeCount: number): string {
  if (activeCount === 0) return "None yet — the co-pilot answers from the practice's own records.";
  if (activeCount <= AUTHORITY_BRIEF_MAX) {
    return `${activeCount} source${activeCount === 1 ? "" : "s"} the co-pilot may cite.`;
  }
  return `${activeCount} sources listed — the co-pilot leans on ${AUTHORITY_BRIEF_MAX} at a time.`;
}

/**
 * The paragraph that explains the bound, or null while there is nothing to
 * explain.
 *
 * IT NAMES WHICH ONES AND HOW TO CHANGE THEM. Telling an owner that only eight
 * of his twelve are used, without saying which eight or what to do about it,
 * swaps one puzzle for another. Archiving is the lever this panel already has,
 * so it is the lever the sentence points at.
 */
export function authoritiesBoundNote(activeCount: number): string | null {
  if (activeCount <= AUTHORITY_BRIEF_MAX) return null;
  return (
    `You have ${activeCount} approved sources and the co-pilot is handed ${AUTHORITY_BRIEF_MAX} of them ` +
    "at a time: the longest-standing ones, marked below. The rest are kept but are not in front of it — " +
    "archive one you no longer work to and the next on the list takes its place."
  );
}

/** The row marker for an active source the brief will not carry. */
export const NOT_IN_USE_LABEL = "Not in use";
