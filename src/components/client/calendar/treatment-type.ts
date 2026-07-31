// ===========================================================================
// APPOINTMENT TYPE -> COLOUR SLOT.
//
// On the practice's own Dentally screen the block FILL tracks the TREATMENT
// TYPE, not the appointment state: two blocks with different state letters share
// one salmon fill, and two blocks with the same letter carry different fills.
// "Scale & Polish" is salmon and "Scale & Polish Extensive Hygiene" is lavender.
// State keeps the left spine, the corner letter, the border treatment and the
// non-hue textures; it no longer owns the fill.
//
// Three layers, first hit wins:
//   (a) canonicalKey  a stable key for a free-ish reason string
//   (b) TYPE_MAP      a CHECKED-IN table, one row per reason string this repo has
//                     seen. Data, not an algorithm, so a human can read it and
//                     argue with it, and so two similar treatments can be two
//                     deliberately different colours.
//   (c) FAMILY_RULES  an ordered fallback by clinical family.
//
// COLOUR IS NOT THE SAFETY CHANNEL. The treatment type is PRINTED on the block.
// No clinical decision rests on telling one hue from another; the word is the
// proof. Colour is glanceable grouping only.
//
// Never a hash: a hash puts two similar treatments in near-identical colours and
// cannot be argued with. Unrecognised is slot 0, which reads as "type not
// recorded" rather than being given a colour by luck.
// ===========================================================================

/** The ten clinical families. Each owns a DISTINCT palette slot. */
export type FamilySlug =
  | "implant"
  | "ortho"
  | "endodontic"
  | "surgical"
  | "restorative"
  | "cosmetic"
  | "hygiene"
  | "emergency"
  | "exam"
  | "treatment";

export const FAMILY_SLUGS: readonly FamilySlug[] = [
  "implant",
  "ortho",
  "endodontic",
  "surgical",
  "restorative",
  "cosmetic",
  "hygiene",
  "emergency",
  "exam",
  "treatment",
] as const;

/** The number of palette slots: 0 is neutral, 1 to 12 are hues. */
export const PALETTE_SLOTS = 13;

/**
 * A stable key for a reason string.
 *
 * "&" becomes " and " BEFORE the strip, so "Scale & Polish" and
 * "scale and polish" collapse to one key rather than to two. Everything that is
 * not a letter or a digit then becomes a single space. Null, empty and
 * whitespace-only all give "".
 */
export function canonicalKey(reason: string | null | undefined): string {
  if (typeof reason !== "string") return "";
  return reason
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export interface TypeRow {
  slot: number;
  label: string;
}

/**
 * Every reason string this repo has actually seen: the Dentally create enum
 * (src/lib/dentally/write.ts) plus the read-path reasons in the mock fixtures.
 *
 * Slots 8 and 11 sitting next to each other is the reference's own evidence:
 * "Scale & Polish" is salmon and "Scale & Polish Extensive Hygiene" is lavender,
 * two colours for two treatments a family rule would have merged.
 */
export const TYPE_MAP: ReadonlyMap<string, TypeRow> = new Map<string, TypeRow>([
  ["exam", { slot: 1, label: "Exam" }],
  ["examination", { slot: 1, label: "Examination" }],
  ["checkup", { slot: 1, label: "Checkup" }],
  ["check up", { slot: 1, label: "Checkup" }],
  ["new patient exam", { slot: 2, label: "New patient exam" }],
  ["exam and scale and polish", { slot: 2, label: "Exam + Scale & Polish" }],
  ["scale and polish", { slot: 8, label: "Scale & Polish" }],
  ["hygiene", { slot: 8, label: "Hygiene" }],
  ["hygienist", { slot: 8, label: "Hygienist" }],
  ["scale and polish extensive hygiene", { slot: 11, label: "Scale & Polish Extensive Hygiene" }],
  ["continuing treatment", { slot: 4, label: "Continuing Treatment" }],
  ["review", { slot: 3, label: "Review" }],
  ["recall", { slot: 3, label: "Recall" }],
  ["consultation", { slot: 3, label: "Consultation" }],
  ["emergency", { slot: 9, label: "Emergency" }],
  ["implant consult", { slot: 12, label: "Implant consult" }],
  ["implant fit", { slot: 12, label: "Implant fit" }],
  ["invisalign review", { slot: 10, label: "Invisalign review" }],
  ["extraction", { slot: 7, label: "Extraction" }],
  ["filling", { slot: 6, label: "Filling" }],
  ["veneers review", { slot: 6, label: "Veneers review" }],
  ["whitening", { slot: 5, label: "Whitening" }],
  ["root canal review", { slot: 11, label: "Root canal review" }],
  ["other", { slot: 0, label: "Other" }],
]);

export interface FamilyRule {
  slug: FamilySlug;
  terms: readonly string[];
  slot: number;
}

/**
 * Ordered MOST SPECIFIC FIRST. The first term hit wins, and the DECLARATION
 * ORDER is the whole correctness argument:
 *   "Invisalign review"  must reach ortho, not treatment
 *   "Root canal review"  must reach endodontic, not treatment
 *   "Implant consult"    must reach implant, not treatment
 * Move `treatment` up this list and all three become the wrong colour.
 */
export const FAMILY_RULES: readonly FamilyRule[] = [
  { slug: "implant", terms: ["implant"], slot: 12 },
  { slug: "ortho", terms: ["invisalign", "aligner", "brace", "retainer", "ortho"], slot: 10 },
  { slug: "endodontic", terms: ["root canal", "endo", "rct", "pulp"], slot: 11 },
  { slug: "surgical", terms: ["extraction", "xla", "wisdom", "surgical"], slot: 7 },
  {
    slug: "restorative",
    terms: ["filling", "crown", "bridge", "veneer", "inlay", "onlay", "composite", "bonding"],
    slot: 6,
  },
  { slug: "cosmetic", terms: ["whitening", "bleach"], slot: 5 },
  { slug: "hygiene", terms: ["hygiene", "hygienist", "scale and polish", "perio"], slot: 8 },
  {
    slug: "emergency",
    terms: ["emergency", "urgent", "pain", "toothache", "abscess", "trauma"],
    slot: 9,
  },
  { slug: "exam", terms: ["exam", "examination", "checkup", "check up", "assessment"], slot: 1 },
  {
    slug: "treatment",
    terms: ["review", "follow up", "continuing treatment", "consult", "consultation", "recall"],
    slot: 3,
  },
] as const;

/** The clinical family a reason belongs to, or null when nothing matches. */
export function familyOf(reason: string | null | undefined): FamilySlug | null {
  const key = canonicalKey(reason);
  if (key === "") return null;
  for (const rule of FAMILY_RULES) {
    for (const term of rule.terms) {
      if (key.includes(term)) return rule.slug;
    }
  }
  return null;
}

/**
 * The palette slot for a reason string.
 *
 * Resolution order: `overrides` (the practice's own configured colours, from
 * public.diary_appointment_type) beats TYPE_MAP, which beats FAMILY_RULES, which
 * falls back to slot 0. Taking an overrides map rather than reading the table
 * here is what keeps this module pure and the test suite untouched when the
 * practice's real configuration arrives.
 *
 * A practice with more than twelve configured types has its extras fall back to
 * their FAMILY's slot, sharing a colour with a clinical sibling while still
 * printing their own name.
 */
export function paletteSlotFor(
  reason: string | null | undefined,
  overrides: ReadonlyMap<string, number> = new Map(),
): number {
  const key = canonicalKey(reason);
  if (key === "") return 0;

  const override = overrides.get(key);
  if (typeof override === "number" && Number.isInteger(override) && override >= 0 && override < PALETTE_SLOTS) {
    return override;
  }

  const mapped = TYPE_MAP.get(key);
  if (mapped) return mapped.slot;

  for (const rule of FAMILY_RULES) {
    for (const term of rule.terms) {
      if (key.includes(term)) return rule.slot;
    }
  }
  return 0;
}

/**
 * The human label for a reason string, or null when we do not have one.
 *
 * Null is not a gap to paper over: the block prints the RAW reason when there is
 * no label, which is more honest than inventing a tidy name for text the
 * practice typed itself.
 */
export function typeLabelFor(
  reason: string | null | undefined,
  overrides: ReadonlyMap<string, string> = new Map(),
): string | null {
  const key = canonicalKey(reason);
  if (key === "") return null;
  const override = overrides.get(key);
  if (typeof override === "string" && override.trim() !== "") return override.trim();
  return TYPE_MAP.get(key)?.label ?? null;
}
