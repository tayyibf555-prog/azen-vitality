// ===========================================================================
// MAY THIS APPOINTMENT CHANGE CLINICIAN?
//
// The practice manager's rule, in her own words on 2026-07-27:
//
//   "if it is continuing treatment then I would not be able to drop it there
//    because the same dentist needs to continue treatment. But for just a
//    checkup, we can drag and drop it."
//
// So a course of treatment may be moved in TIME as much as anyone likes, and may
// NOT be handed to a different practitioner. A checkup, an exam or a hygiene
// visit may go to whoever is free.
//
// THIS IS CLINICAL, NOT COSMETIC. A wrongly-ALLOWED move breaks a course of
// treatment: the second half of a root canal lands with a dentist who did not
// open the tooth, has not seen the canal anatomy and did not place the dressing.
// A wrongly-REFUSED move costs a click. The two are not comparable, so anything
// this module cannot classify is REFUSED and SAID TO BE UNCLEAR, never allowed
// on the balance of probability.
//
// PURE, and in .ts rather than inside the drag hook, because vitest here collects
// only src/**/*.test.ts under the node environment: a rule that lived in a React
// closure could not be tested at all, and four defects in this repo have already
// shipped that way.
//
// WHERE THE VOCABULARY COMES FROM. Nothing here is invented. The three classes
// are derived from the treatment-type vocabulary that already drives the block
// colours (components/client/calendar/treatment-type.ts): its canonicalKey, its
// checked-in TYPE_MAP keys and its ten clinical families. `continuityForKey`
// below carries ONE ROW PER TYPE_MAP KEY, so adding a treatment type without
// deciding its continuity is a test failure rather than a silent fall-through.
// ===========================================================================

import {
  FAMILY_SLUGS,
  TYPE_MAP,
  canonicalKey,
  familyOf,
  typeLabelFor,
  type FamilySlug,
} from "@/components/client/calendar/treatment-type";

/**
 * What a reason string says about who must deliver it.
 *
 *   "continuing"    a course. It stays with the clinician who started it.
 *   "transferable"  routine. Any clinician on the day may take it.
 *   "unclear"       we cannot tell. Treated as continuing, and SAID to be
 *                   unclear rather than dressed up as a clinical claim.
 */
export type Continuity = "continuing" | "transferable" | "unclear";

/**
 * The continuity of each clinical family.
 *
 * Read it as: does a visit of this kind belong to a course one clinician is
 * carrying? Implant, ortho, endodontic, surgical, restorative and cosmetic work
 * all do — they are staged, and each stage depends on what the previous one
 * found. Exam and hygiene do not: they are the routine visit Blerta named, and a
 * hygiene appointment is delivered by whichever hygienist is in.
 *
 * `emergency` and `treatment` are DELIBERATELY unclear rather than either
 * answer, and this is the judgement most worth arguing with:
 *
 *   emergency  an unplanned visit has no prior clinician by definition, which
 *              argues transferable. But "Emergency" is also typed onto the
 *              follow-up half of somebody else's extraction, which argues
 *              continuing. Two readings, no way to tell them apart from the
 *              string, so: unclear.
 *   treatment  the family holding review / follow up / consultation. "Review"
 *              is almost always a review OF something, and that something has an
 *              owner. The individual keys that ARE routine (recall, and the exam
 *              and hygiene rows) are pinned in the key table below and never
 *              reach this fallback.
 */
export const FAMILY_CONTINUITY: Readonly<Record<FamilySlug, Continuity>> = {
  implant: "continuing",
  ortho: "continuing",
  endodontic: "continuing",
  surgical: "continuing",
  restorative: "continuing",
  cosmetic: "continuing",
  hygiene: "transferable",
  exam: "transferable",
  emergency: "unclear",
  treatment: "unclear",
};

/**
 * ONE ROW PER TYPE_MAP KEY. Data, not an algorithm, so a clinician can read it
 * and disagree with a single line without touching any logic.
 *
 * The rows that EARN their place are the ones whose family would answer
 * differently: "recall" is in the `treatment` family (which is unclear) and is
 * pinned transferable, because a recall IS the routine check-up. Everything else
 * agrees with its family and is written out anyway, so the completeness test
 * below can hold.
 */
export const KEY_CONTINUITY: ReadonlyMap<string, Continuity> = new Map<string, Continuity>([
  // Routine. Blerta: "for just a checkup, we can drag and drop it."
  ["exam", "transferable"],
  ["examination", "transferable"],
  ["checkup", "transferable"],
  ["check up", "transferable"],
  ["new patient exam", "transferable"],
  ["exam and scale and polish", "transferable"],
  ["scale and polish", "transferable"],
  ["hygiene", "transferable"],
  ["hygienist", "transferable"],
  ["scale and polish extensive hygiene", "transferable"],
  ["recall", "transferable"],

  // Named continuing by the practice's own vocabulary.
  ["continuing treatment", "continuing"],

  // Courses. Every one of these is a stage of work somebody is carrying.
  ["implant consult", "continuing"],
  ["implant fit", "continuing"],
  ["invisalign review", "continuing"],
  ["root canal review", "continuing"],
  ["veneers review", "continuing"],
  ["extraction", "continuing"],
  ["filling", "continuing"],
  ["whitening", "continuing"],

  // Cannot be told apart from the string alone. See FAMILY_CONTINUITY.
  ["review", "unclear"],
  ["consultation", "unclear"],
  ["emergency", "unclear"],
  ["other", "unclear"],
]);

/**
 * Free text that names a continuing course outright.
 *
 * Checked as SUBSTRINGS, after the exact key table and before the family, so
 * "Continuing treatment - upper right 6" is recognised as continuing instead of
 * falling through to the `treatment` family and being reported as merely
 * unclear. The refusal is the same either way; the sentence the reader gets is
 * not, and "this is continuing treatment" is a better thing to be told than "we
 * cannot tell".
 */
export const CONTINUING_TERMS: readonly string[] = [
  "continuing treatment",
  "continuing care",
  "course of treatment",
] as const;

/**
 * The continuity class of a reason string.
 *
 * Resolution order, first hit wins:
 *   1. nothing recorded            -> unclear
 *   2. the exact key table         -> its row
 *   3. an explicit continuing term -> continuing
 *   4. the clinical family         -> FAMILY_CONTINUITY
 *   5. no family at all            -> unclear
 */
export function continuityOf(reason: string | null | undefined): Continuity {
  const key = canonicalKey(reason);
  if (key === "") return "unclear";

  const pinned = KEY_CONTINUITY.get(key);
  if (pinned) return pinned;

  for (const term of CONTINUING_TERMS) {
    if (key.includes(term)) return "continuing";
  }

  const family = familyOf(reason);
  if (family === null) return "unclear";
  return FAMILY_CONTINUITY[family];
}

export type ContinuityRefusalCode = "continuing_treatment" | "continuity_unclear";

export type ContinuityVerdict =
  | { ok: true }
  | { ok: false; code: ContinuityRefusalCode; message: string };

export interface ContinuityInput {
  /** The appointment's own reason string, exactly as Dentally holds it. */
  reason: string | null | undefined;
  /** Who has it now. null is Unassigned: nobody's course to break. */
  fromPractitionerId: string | null;
  /** Named in the refusal, because "it must stay where it is" teaches nothing. */
  fromPractitionerName: string | null | undefined;
  /** Where the drag wants to put it. */
  toPractitionerId: string | null;
}

function nameOr(raw: string | null | undefined): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed === "" ? "the same clinician" : trimmed;
}

/** "(Root canal review) " or "", for splicing into a sentence. */
function bracketed(reason: string | null | undefined): string {
  // "this is continuing treatment (Continuing Treatment)" says the same thing
  // twice. The bracket exists to name a treatment the sentence has NOT named.
  if (canonicalKey(reason) === "continuing treatment") return "";
  const label = typeLabelFor(reason);
  if (label !== null) return ` (${label})`;
  const raw = typeof reason === "string" ? reason.trim() : "";
  if (raw === "") return "";
  // The practice's own free text, printed back verbatim but bounded, so a
  // pasted paragraph cannot become the whole refusal.
  return ` (${raw.length > 40 ? `${raw.slice(0, 39)}…` : raw})`;
}

/**
 * May this appointment be handed to this practitioner?
 *
 * A move that keeps the SAME practitioner is always allowed here: this rule is
 * about who delivers the treatment, never about when. So dragging a root canal
 * three hours later in its own column passes, and dragging it one column across
 * does not.
 *
 * An appointment sitting in Unassigned has no clinician to keep it with, so
 * ASSIGNING one breaks no course and is allowed. (Moving one INTO Unassigned is
 * refused earlier, by validateMove, on separate grounds: Unassigned is not a
 * person and has no availability to check.)
 */
export function checkContinuity(input: ContinuityInput): ContinuityVerdict {
  const from = input.fromPractitionerId;
  const to = input.toPractitionerId;

  // Same clinician, or no clinician to leave. Nothing continuing is at risk.
  if (from === null || from === to) return { ok: true };

  const verdict = continuityOf(input.reason);
  if (verdict === "transferable") return { ok: true };

  const name = nameOr(input.fromPractitionerName);
  const what = bracketed(input.reason);

  // THE CLINICIAN'S NAME COMES FIRST, and this is not a style choice.
  //
  // The drag preview draws the refusal on a chip cut to REFUSAL_CHIP_MAX (40)
  // characters, because the chip sits on a 112px column. The earlier wording put
  // the name at character 76, so the only thing a SIGHTED reader ever saw was
  // "This is continuing treatment (Continuin…" — the one fact the practice
  // manager asked for, the clinician it has to stay with, cut off. The full
  // sentence went to a live region nobody watching the screen can read.
  //
  // Leading with "Must stay with <name>:" puts the name inside the first forty
  // characters of every one of these three refusals, so the chip, the dialog and
  // the announcement all name them. move-copy.test.ts asserts exactly that
  // against the real truncation, so this cannot silently regress.
  if (verdict === "continuing") {
    return {
      ok: false,
      code: "continuing_treatment",
      message: `Must stay with ${name}: this is continuing treatment${what}. Move it to another time in their column, or cancel it and book a new appointment with the other clinician.`,
    };
  }

  const key = canonicalKey(input.reason);
  if (key === "") {
    return {
      ok: false,
      code: "continuity_unclear",
      message: `Must stay with ${name}: this appointment has no treatment type recorded, so we cannot tell whether it is continuing treatment. It stays with them until one is set in Dentally.`,
    };
  }

  return {
    ok: false,
    code: "continuity_unclear",
    message: `Must stay with ${name}: we cannot tell whether this is continuing treatment${what}. Move it to another time in their column, or cancel it and book a new appointment with the other clinician.`,
  };
}

/**
 * Every TYPE_MAP key, so the completeness test can assert the key table covers
 * them all. Exported rather than recomputed in the test, so the two cannot
 * disagree about what "every key" means.
 */
export function typeMapKeys(): string[] {
  return [...TYPE_MAP.keys()];
}

/** Every family slug, for the same reason. */
export function familySlugs(): readonly FamilySlug[] {
  return FAMILY_SLUGS;
}
