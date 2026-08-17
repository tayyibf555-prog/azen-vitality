// A2's content blocks and answer-card pictures, RESOLVED FOR DRAWING.
//
// WHAT THIS IS. flow.ts stores what an owner AUTHORED: a block kind, some short
// strings, and - for a picture - a KEY into the curated manifest (CUT 4). Nothing
// stored is directly renderable: a key is not a src, and an authored alt may be
// missing on a picture whose manifest entry has one. This module is the single
// place that turns the authored form into the drawable form, so the public quiz
// and the builder's phone minis draw the same furniture from the same resolution
// and cannot disagree about what a funnel contains.
//
// WHY IT IS A LIB AND NOT A COMPONENT. vitest collects src/**\/*.test.ts only, so
// a resolution rule that lives inside JSX is a rule no test can reach. Every
// decision below - which pictures resolve, which are refused, which alt text wins,
// what happens to a block that cannot be drawn - is a rule with a mutation test in
// flow-block-view.test.ts. The two components that consume this hold no rules at
// all: they map over what they are handed.
//
// BUNDLE SAFETY. Imports ./flow and the manifest, and NOTHING else - in particular
// not ./quiz, which carries the option WEIGHTS (flow.ts:11-19). This module is
// reachable from the browser through deterministic-assessment-quiz.tsx, so that
// boundary is the same one flow-runtime.ts holds, for the same reason. The
// manifest is safe to publish by construction: it is paths and alt text for assets
// we already ship under /public, and it is what every renderer would have to
// resolve a key through anyway.
//
// DRAW NOTHING RATHER THAN DRAW A GUESS. Every refusal below drops the ONE thing
// it cannot vouch for and keeps the rest of the screen. That is the opposite of
// normaliseFlow's all-or-nothing doctrine (flow.ts:343-357), and deliberately so:
// normaliseFlow decides whether a funnel is READABLE, where a partial read is a
// broken quiz that still looks like it works. This decides whether one piece of
// FURNITURE is drawable, where the only alternatives are an <img> pointing at
// nothing, or a screen that refuses to render because a picture was renamed. A
// dropped block costs a practice one piece of reassurance; a broken funnel costs
// them the lead. Rule 13 (flow-validate.ts) is what stops it silently: an unknown
// or misplaced key is rejected at WRITE time with a message, so the only way to
// reach a refusal here is a manifest that changed under a stored funnel.

import { blocksOf, optionImagesOf, type FlowBlock, type FlowFaqItem, type FlowNode } from "./flow";
import { assessImage, type AssessImageSlot } from "@/lib/assess/image-library";

/**
 * A picture a renderer may actually put on a page: a real path under /public,
 * words a screen reader can say, and the intrinsic box so nothing reflows when the
 * lazy-loaded file lands.
 */
export interface ImageView {
  src: string;
  alt: string;
  width: number;
  height: number;
}

/** A block in the shape its component takes. The image block is the only one that resolves. */
export type BlockView =
  | { kind: "trust-strip"; practiceName: string; chips: string[] }
  | { kind: "testimonial"; quote: string; attribution: string }
  | { kind: "faq"; items: FlowFaqItem[] }
  | { kind: "image"; image: ImageView }
  | BookingBlockView;

/**
 * The booking invitation, resolved. Two strings, like the block it comes from:
 * everything that makes it BEHAVE (the site, the calendar, the write) is decided
 * by the runtime, not here, because this module is reachable from the browser and
 * knows nothing about practices or diaries.
 */
export interface BookingBlockView {
  kind: "booking";
  headline: string;
  blurb: string;
}

/**
 * THE ALT RULE, on its own so it can be tested on its own.
 *
 * An authored alt wins, because the owner wrote it about the picture they chose
 * for the screen they chose it for; the manifest's own alt is the fallback,
 * because an answer tile has no authored alt at all (there is no field for one -
 * flow.ts, FlowOptionImage). A blank authored alt falls through rather than
 * winning: `alt=""` means DECORATIVE to a screen reader, and a picture an owner
 * deliberately added to a funnel is not decorative.
 *
 * null when neither says anything, and null means the picture is not drawn at all.
 * A picture with no alt is a picture a screen reader announces as "image" and
 * moves past, on a page whose whole job is to be understood by a patient who has
 * not met the practice yet.
 */
export function altFor(authored: string | null | undefined, fallback: string | null | undefined): string | null {
  const own = (authored ?? "").trim();
  if (own) return own;
  const spare = (fallback ?? "").trim();
  return spare || null;
}

/**
 * The manifest entry for a key, drawable, or null.
 *
 * THE SLOT IS CHECKED HERE TOO, not only at write time. rule 13 already refuses a
 * hero key on an answer card, so reaching this with a mismatch means the manifest
 * moved under a stored funnel - and the failure it prevents is not cosmetic: a
 * 1000px hero repeated across eight answer cards is a megabyte of nothing on a
 * phone (image-library.ts:20-23).
 */
export function imageViewFor(
  key: string | null | undefined,
  slot: AssessImageSlot,
  authoredAlt?: string | null,
): ImageView | null {
  const entry = assessImage(key);
  if (!entry || entry.slot !== slot) return null;
  const alt = altFor(authoredAlt, entry.alt);
  if (!alt) return null;
  return { src: entry.path, alt, width: entry.width, height: entry.height };
}

/** One block, drawable, or null when its picture cannot be resolved. */
function blockView(block: FlowBlock): BlockView | null {
  switch (block.kind) {
    case "trust-strip":
      // Copies, not the stored arrays: a component that sorted or sliced what it
      // was handed would be editing the campaign row through a render.
      return { kind: "trust-strip", practiceName: block.practiceName, chips: [...block.chips] };
    case "testimonial":
      return { kind: "testimonial", quote: block.quote, attribution: block.attribution };
    case "faq":
      return { kind: "faq", items: block.items.map((i) => ({ q: i.q, a: i.a })) };
    case "image": {
      const image = imageViewFor(block.image, "hero", block.alt);
      return image ? { kind: "image", image } : null;
    }
    case "booking":
      return { kind: "booking", headline: block.headline, blurb: block.blurb };
    default:
      return null;
  }
}

/**
 * The furniture on a screen, in AUTHORED ORDER, minus anything that cannot be
 * drawn. Empty for every node kind that cannot carry blocks, because blocksOf
 * already answers that question (flow.ts) - a renderer must never have to know
 * which kinds those are.
 */
export function blockViews(node: FlowNode): BlockView[] {
  const out: BlockView[] = [];
  for (const b of blocksOf(node)) {
    const view = blockView(b);
    if (view) out.push(view);
  }
  return out;
}

/**
 * THE SPLIT (C1). Everything on this screen that is DRAWN WHERE IT SITS, which is
 * everything except the booking invitation.
 *
 * A booking block is authored in the block list like any other and is drawn from
 * the same projection everywhere it is only a PICTURE of itself - the phone mini,
 * the flow canvas. But on the live funnel it is not a section of the result
 * screen: it is a button, and a whole screen behind the button (the calendar,
 * with its own state and its own network calls). So the public renderer takes
 * these for its block strip and bookingBlockView for the button, and the 1390-line
 * stateful component never ends up inside the `.map()` that draws the furniture.
 *
 * IDENTICAL TO blockViews FOR EVERY FUNNEL WITHOUT ONE, which is every funnel
 * drawn before C1 - the filter is the only difference and it removes nothing.
 */
export function inlineBlockViews(node: FlowNode): BlockView[] {
  return blockViews(node).filter((v) => v.kind !== "booking");
}

/**
 * The booking invitation authored on this screen, or null.
 *
 * FIRST WINS on the impossible pair (rule 12's block_duplicate_kind refuses a
 * second at write time), matching nodeMap and optionImageViews: a stored list is
 * authored, and a second of anything is a mistake rather than an override.
 *
 * PRESENCE IS NOT PERMISSION. This says the owner asked for a booking screen.
 * Whether one may actually be mounted is booking-embed.ts's answer, and it needs
 * three more things this module cannot see: the practice's online-booking switch,
 * the site to book into, and whether this is a live patient or an owner clicking
 * through a preview.
 */
export function bookingBlockView(node: FlowNode): BookingBlockView | null {
  for (const v of blockViews(node)) {
    if (v.kind === "booking") return v;
  }
  return null;
}

/**
 * The answer-card pictures on a question node, keyed by OPTION VALUE - the same
 * key the option rows are already drawn by, so a renderer looks a picture up
 * rather than pairing two lists by index and getting it wrong on the question
 * where only three of eight options have art.
 *
 * FIRST ENTRY WINS on a repeated value, matching nodeMap's rule for duplicate
 * node ids (flow.ts): a stored list is authored, and a second picture for the same
 * answer is a mistake, not an override.
 */
export function optionImageViews(node: FlowNode): Map<string, ImageView> {
  const out = new Map<string, ImageView>();
  for (const o of optionImagesOf(node)) {
    if (out.has(o.value)) continue;
    const view = imageViewFor(o.image, "answer");
    if (view) out.set(o.value, view);
  }
  return out;
}
