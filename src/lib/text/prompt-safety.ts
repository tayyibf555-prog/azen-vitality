// ===========================================================================
// ONE DEFINITION OF "A CONTROL CHARACTER", AND ONE OF "A PLATFORM LABEL".
//
// WHY THIS MODULE EXISTS, WHICH IS NOT DEDUPLICATION FOR ITS OWN SAKE. Two
// modules were carrying byte-identical copies of the same character class --
// `stripControls` in src/lib/practice-brain/fencing.ts and again in
// src/lib/knowledge/authorities.ts — each with a comment telling the next reader
// that the other copy existed and had to change with it. That is a convention,
// and a convention is advice: the class is the boundary between "text a person
// typed" and "a separator a model reads as structure", and a boundary defined
// twice is a boundary one edit away from being defined differently.
//
// WHY THEY COULD NOT SIMPLY IMPORT EACH OTHER. fencing.ts opens with
// `import { randomBytes } from "node:crypto"` (it mints fence nonces), and
// authorities.ts is imported by
// src/components/client/copilot/authorities-panel.tsx, whose first line is
// "use client". Importing fencing.ts from there would pull node:crypto into the
// browser bundle. So the shared half lives HERE, with no imports at all, and the
// nonce machinery stays in fencing.ts where it belongs.
//
// THIS MODULE IS PURE AND DEPENDENCY-FREE ON PURPOSE. No node: imports, no
// `server-only`, no environment — it is reachable from a server module, a client
// component and a test alike, which is the whole reason the duplication existed.
// Keep it that way: anything needing crypto, the filesystem or a database belongs
// in the module that calls this one.
//
// WHAT IS NOT HERE. Fences (`fence`, `fenceRule`, `newFenceNonce`) stay in
// practice-brain/fencing.ts, and the clinical-note sanitiser stays in
// copilot/second-opinion.ts: those make DIFFERENT trade-offs about whitespace and
// sentence cuts for good, documented reasons, and folding them together would
// flatten a note's paragraphs or truncate an allergy on line two.
// ===========================================================================

/**
 * Strip what must never survive into a prompt: C0 controls, DEL and the C1
 * block (U+0080-U+009F, which includes NEL U+0085).
 *
 * Whitespace is otherwise LEFT ALONE. Newline, tab and carriage return are
 * DELIBERATELY spared, because a knowledge body's or a practice note's
 * paragraphs are part of what the author wrote, and flattening them would change
 * the text. A caller that needs one line (`plainLabel` here, `oneLineLabel` in
 * the authorities brief) collapses whitespace itself, afterwards.
 *
 * The C1 block is the half a naive strip misses: JS `\s` does not match U+0085,
 * so a C1 control survives a whitespace collapse and reaches the prompt as an
 * invisible separator.
 */
export function stripControls(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]+/g, " ");
}

/**
 * The most a platform label may be. Long enough for any real branch name or the
 * classifier's "max 8 words" title, short enough that a wall of text cannot bury
 * the labels around it.
 */
export const PLAIN_LABEL_MAX = 120;

/** Stands in for an empty label, so a `title:` line is never blank. */
export const EMPTY_LABEL = "Untitled note";

/**
 * Force a value into the shape of a single platform-written label.
 *
 * In order: the nonce goes (a label must not be able to close a fence either),
 * then `stripControls` takes C0, DEL and C1 (the same class the fence uses, so
 * there is ONE definition of a control character in this tree), then EVERY
 * remaining run of whitespace collapses to one space. That collapse is the
 * load-bearing step, because it is the newline that turns a value into a line
 * and a line into an item. JS `\s` covers the separators a naive `\n` strip
 * misses (U+2028 LINE SEPARATOR and the U+2000 block; U+0085 NEL goes with the
 * C1 controls). The length cap ends it.
 *
 * PURE. `nonce` is optional so a non-prompt caller can normalise a label too.
 */
export function plainLabel(text: string | null | undefined, nonce?: string): string {
  const raw = String(text ?? "");
  const withoutNonce = nonce ? raw.split(nonce).join(" ") : raw;
  const oneLine = stripControls(withoutNonce)
    .replace(/\s+/g, " ")
    .trim();
  if (oneLine.length === 0) return EMPTY_LABEL;
  if (oneLine.length <= PLAIN_LABEL_MAX) return oneLine;
  return `${oneLine.slice(0, PLAIN_LABEL_MAX).trimEnd()}...`;
}
