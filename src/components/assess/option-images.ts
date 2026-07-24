// Optional 3D-model ARTWORK for quiz answer options, used by the Guided assessment
// style only (assessment-quiz.tsx / assessment-preview.tsx keep their icon tiles).
// Where a map entry exists the Guided tile swaps its lucide icon chip for the
// render; where it does not, the icon chip is drawn unchanged. Most options have
// no art and never will, so the null path is the NORMAL case, not an error case.
//
// KEYING RULE: every key is `"<questionId>:<optionValue>"`, never the value alone.
// This is load-bearing, not stylistic. Option values are only unique WITHIN a
// question: `unsure` is currently reused by four different questions
// (budget_readiness, implant_scope, align_detail, smile_concern) and `crowded` /
// `gaps` are meaningful only under smile_concern. option-icons.ts gets away with a
// flat value-keyed map because a generic "not sure" glyph suits every one of those
// four questions; a PHOTOGRAPH does not, so a flat map here would put a picture of
// teeth next to "I'm not sure how I'd fund it". Hence questionId + value.
//
// Paths point at the assess-owned, tile-sized derivatives under
// /public/assess/conditions (360x270 WebP, ~4-5KB each: 2x the ~170px rendered tile
// so it stays crisp, and a 4:3 intrinsic ratio matching OPTION_IMAGE_WIDTH/HEIGHT
// below). Per project convention each area owns its own asset folder, so this never
// reaches across into the landing pages' /public/landing tree.
//
// Pure data + pure lookups: no JSX, no React, no I/O, so it is directly unit
// testable (option-images.test.ts).

/** Intrinsic size of every option render, set on the <img> to reserve layout. */
export const OPTION_IMAGE_WIDTH = 360;
export const OPTION_IMAGE_HEIGHT = 270;

/** Build the composite map key. Exported so tests assert on the real thing. */
export function optionImageKey(questionId: string, value: string): string {
  return `${questionId}:${value}`;
}

/** `"<questionId>:<optionValue>"` -> path under /public. */
export const OPTION_IMAGES: Record<string, string> = {
  // smile_concern (quiz.ts): the picture question for the aligners path. `even` is
  // the "my bite looks fairly even" option; `unsure` deliberately has NO render,
  // so it degrades to its icon like every other unmapped option.
  "smile_concern:crowded": "/assess/conditions/crowded.webp",
  "smile_concern:gaps": "/assess/conditions/gaps.webp",
  "smile_concern:open_bite": "/assess/conditions/open-bite.webp",
  "smile_concern:overbite": "/assess/conditions/overbite.webp",
  "smile_concern:underbite": "/assess/conditions/underbite.webp",
  "smile_concern:crossbite": "/assess/conditions/crossbite.webp",
  "smile_concern:even": "/assess/conditions/even-bite.webp",
};

/**
 * Alt text, same keys as OPTION_IMAGES (key parity is unit-tested). Wording follows
 * the house style already used for the equivalent renders elsewhere on the site
 * ("Crowded teeth 3D model"): it names what the render SHOWS and nothing more, so
 * it stays descriptive rather than diagnostic. The strings are copied rather than
 * imported so this module has no dependency outside its own area.
 */
export const OPTION_IMAGE_ALT: Record<string, string> = {
  "smile_concern:crowded": "Crowded teeth 3D model",
  "smile_concern:gaps": "Gaps between teeth 3D model",
  "smile_concern:open_bite": "Open bite 3D model",
  "smile_concern:overbite": "Overbite 3D model",
  "smile_concern:underbite": "Underbite 3D model",
  "smile_concern:crossbite": "Crossbite 3D model",
  "smile_concern:even": "Even bite 3D model",
};

/** The render for one option, or null when it has none (the common case). */
export function imageFor(questionId: string, value: string): string | null {
  return OPTION_IMAGES[optionImageKey(questionId, value)] ?? null;
}

/** Alt text for that render, or null when the option has no render. */
export function imageAltFor(questionId: string, value: string): string | null {
  return OPTION_IMAGE_ALT[optionImageKey(questionId, value)] ?? null;
}

/**
 * Per-question HERO artwork, drawn once above the question rather than per option.
 * The seam is wired end to end (QuestionStep renders it when present) but the map
 * is INTENTIONALLY EMPTY: no hero art is shipping yet. Adding one is a single line
 * here; dropping the idea is deleting this map, heroFor, and the one block in
 * guided-assessment-quiz.tsx that calls it.
 */
export const QUESTION_HERO_IMAGES: Record<string, string> = {};

/** Hero artwork for a question, or null. Currently always null (see above). */
export function heroFor(questionId: string): string | null {
  return QUESTION_HERO_IMAGES[questionId] ?? null;
}
