// THE CURATED IMAGE LIBRARY for the Smile Assessment funnel: the closed list of
// pictures a practice owner may put on a funnel screen or an answer card.
//
// WHY A MANIFEST AND NOT A URL FIELD. A funnel is owner-authored jsonb that ends
// up on a public, ad-destination page. If a block carried a URL, that URL would be
// whatever was in the row: an off-site tracker, a broken link, a competitor's
// before-and-after, a 4MB hero on a phone. Every one of those is a support ticket
// at best and an ASA problem at worst, and none of them can be caught by a length
// cap. So the stored value is a KEY into this file, and a raw URL is invalid BY
// CONSTRUCTION: there is no key shaped like a URL, so no URL can resolve, so no
// URL can render. flow-validate rule 13 rejects a key that is not in here at write
// time, and the renderer resolves through assessImage(), which returns null for
// anything unknown rather than emitting a src it cannot vouch for.
//
// EVERY PATH IS A STATIC ASSET WE SHIP, under /public/assess/** or
// /public/landing/**. image-library.test.ts walks the manifest against the real
// file tree, so a renamed or deleted file goes red here rather than as a broken
// image on a live funnel.
//
// SLOTS. An asset is fit for one job. The condition renders are 360x270 tiles: a
// funnel screen that stretched one across a hero would show a blurry mess, and a
// 1000px hero repeated across eight answer cards is a megabyte of nothing on a
// phone. So each entry declares its slot and rule 13 enforces the match.
//
// WHAT IS DELIBERATELY NOT IN HERE, and it is not an oversight:
//
//   /public/landing/invisalign/before-after/** - before-and-after photographs are
//   an OUTCOME CLAIM. The programme charter rules them out of funnel imagery, and
//   a picture makes a claim no compliance scanner can read.
//
//   /public/landing/invisalign/patients/** - the landing page presents those
//   portraits as patient stories in a section written and signed off for that
//   page. Lifted into a funnel next to a testimonial block they read as "this is
//   the person who said that", which is a claim nobody has verified.
//
//   /public/landing/invisalign/conditions/*.png - the same seven conditions as
//   /assess/conditions, but PNG and page-sized. The assess-owned WebP derivatives
//   are 4-5KB against 60KB+, and one canonical key per picture keeps the picker
//   honest.
//
// PURE DATA. No React, no server imports, no I/O, so the public page, the builder
// panel, the validator and the API route can all import it - the same boundary
// palette.ts holds.

/** Where an asset is fit to be drawn. */
export type AssessImageSlot =
  /** A full-width picture on a welcome or result screen. */
  | "hero"
  /** A tile on an answer card, drawn once per option in a grid. */
  | "answer";

export interface AssessImage {
  /**
   * The stored reference. Lowercase, dash-separated, one optional group prefix.
   * This is what lands in the jsonb, so it is stable for ever once shipped:
   * renaming a key orphans every funnel that used it (rule 13 would then reject
   * the funnel, loudly, which is the right failure but still a failure).
   */
  key: string;
  /** Path under /public, as it is written into a src attribute. */
  path: string;
  /**
   * Default alt text, used wherever the author has no alt field of their own
   * (answer tiles). Describes what the picture SHOWS and nothing more, so it stays
   * descriptive rather than diagnostic - the same wording rule option-images.ts
   * follows. Scanned by the compliance lint in the sibling test.
   */
  alt: string;
  /** Intrinsic size, so a renderer can reserve layout and never reflow. */
  width: number;
  height: number;
  slot: AssessImageSlot;
  /** Owner-facing grouping for the picker. */
  group: string;
}

/**
 * The shape a key must have: lowercase alphanumerics and dashes, in one or two
 * slash-separated segments.
 *
 * IT IS CHECKED IN BOTH DIRECTIONS, and the second direction is the load-bearing
 * one. On the way IN it rejects a value that could not possibly be a key (a URL,
 * a path, a "../.." traversal, a data: blob) on sight rather than by absence. On
 * the way OUT the sibling test holds every entry in the manifest to it, which is
 * what makes "a raw URL is invalid by construction" true rather than merely true
 * today: nothing URL-shaped can BE a key, so no lookup can ever resolve one.
 */
export const ASSESS_IMAGE_KEY_FORMAT = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)?$/;
const KEY_FORMAT = ASSESS_IMAGE_KEY_FORMAT;

/** The allowlisted roots. Nothing outside these may be listed. */
export const ASSESS_IMAGE_ROOTS: readonly string[] = ["/assess/", "/landing/"];

export const ASSESS_IMAGES: readonly AssessImage[] = [
  // --- Answer tiles: the picture question (quiz.ts smile_concern). -----------
  // 360x270 WebP derivatives, ~4-5KB each, already shipped for the Guided style
  // (src/components/assess/option-images.ts). Keys are the OPTION VALUES they
  // illustrate, so a picker can suggest the right tile for the right answer.
  {
    key: "conditions/crowded",
    path: "/assess/conditions/crowded.webp",
    alt: "Crowded teeth 3D model",
    width: 360,
    height: 270,
    slot: "answer",
    group: "Conditions",
  },
  {
    key: "conditions/gaps",
    path: "/assess/conditions/gaps.webp",
    alt: "Gaps between teeth 3D model",
    width: 360,
    height: 270,
    slot: "answer",
    group: "Conditions",
  },
  {
    key: "conditions/open-bite",
    path: "/assess/conditions/open-bite.webp",
    alt: "Open bite 3D model",
    width: 360,
    height: 270,
    slot: "answer",
    group: "Conditions",
  },
  {
    key: "conditions/overbite",
    path: "/assess/conditions/overbite.webp",
    alt: "Overbite 3D model",
    width: 360,
    height: 270,
    slot: "answer",
    group: "Conditions",
  },
  {
    key: "conditions/underbite",
    path: "/assess/conditions/underbite.webp",
    alt: "Underbite 3D model",
    width: 360,
    height: 270,
    slot: "answer",
    group: "Conditions",
  },
  {
    key: "conditions/crossbite",
    path: "/assess/conditions/crossbite.webp",
    alt: "Crossbite 3D model",
    width: 360,
    height: 270,
    slot: "answer",
    group: "Conditions",
  },
  {
    // 269 rather than 270 is the real file, not a typo: the intrinsic size is
    // measured from the asset, because a wrong one is a one-pixel reflow.
    key: "conditions/even-bite",
    path: "/assess/conditions/even-bite.webp",
    alt: "Even bite 3D model",
    width: 360,
    height: 269,
    slot: "answer",
    group: "Conditions",
  },

  // --- Screen pictures. ------------------------------------------------------
  // Two to start with, both already shipped and already signed off on a public
  // landing page. The curated Higgsfield set lands in this same list below; the
  // picker and the validator did not change when it did.
  {
    key: "screens/aligners",
    path: "/landing/invisalign/aligners.jpg",
    alt: "A pair of clear aligners",
    width: 1000,
    height: 747,
    slot: "hero",
    group: "Treatment",
  },
  {
    key: "screens/fresh-smile",
    path: "/landing/hygiene/fresh-smile.jpg",
    alt: "A hygiene appointment at the practice",
    width: 1000,
    height: 747,
    slot: "hero",
    group: "Practice",
  },

  // --- The curated library. --------------------------------------------------
  // Fourteen commissioned pictures, ours to use, under /assess/library so they
  // are assess-owned rather than borrowed off a landing page whose sign-off was
  // for that page. WebP derivatives of the raw renders: 1280x720 for the screen
  // pictures, 720x540 for the answer tiles and the lifestyle shots.
  //
  // APPENDED, NEVER INSERTED. flow-edit's "give this block a picture" default and
  // two of its tests take assessImagesForSlot("hero")[0], so the manifest's head
  // is load-bearing order. New entries go on the end.
  //
  // THE TILES ARE UNDER 14KB against the suite's 20KB ceiling, which is headroom
  // on purpose: eight of them can land on one answer grid, on a phone, on a paid
  // click. Quality was searched down to that budget per picture rather than set
  // to one number, because a crown on woven cloth costs far more bits than a
  // smile against a plain wall.
  //
  // THE ALT TEXT SAYS WHAT IS IN THE FRAME AND STOPS. No treatment named as a
  // result, no "after", no adjective doing persuasion: an alt string is copy on a
  // public ad-destination page and the sibling test scans it like copy.
  {
    key: "library/reception-morning",
    path: "/assess/library/reception-morning.webp",
    alt: "A practice reception area in morning light",
    width: 1280,
    height: 720,
    slot: "hero",
    group: "Practice",
  },
  {
    key: "library/natural-smile",
    path: "/assess/library/natural-smile.webp",
    alt: "A woman smiling and looking out of a window",
    width: 1280,
    height: 720,
    slot: "hero",
    group: "People",
  },
  {
    key: "library/aligner-light",
    path: "/assess/library/aligner-light.webp",
    alt: "A clear aligner held up to the light",
    width: 1280,
    height: 720,
    slot: "hero",
    group: "Treatment",
  },
  {
    key: "library/aligner-case",
    path: "/assess/library/aligner-case.webp",
    alt: "A clear aligner in its storage case",
    width: 720,
    height: 540,
    slot: "answer",
    group: "Treatment",
  },
  {
    key: "library/ceramic-crown",
    path: "/assess/library/ceramic-crown.webp",
    alt: "A ceramic crown resting on a folded cloth",
    width: 720,
    height: 540,
    slot: "answer",
    group: "Treatment",
  },
  {
    key: "library/confident-smile",
    path: "/assess/library/confident-smile.webp",
    alt: "A close view of a woman smiling",
    width: 720,
    height: 540,
    slot: "answer",
    group: "People",
  },
  {
    key: "library/shade-match",
    path: "/assess/library/shade-match.webp",
    alt: "A dentist holding a shade guide beside a patient's teeth",
    width: 720,
    height: 540,
    slot: "answer",
    group: "Treatment",
  },
  {
    key: "library/whitening-guide",
    path: "/assess/library/whitening-guide.webp",
    alt: "A tooth shade guide on a worktop beside a mirror",
    width: 720,
    height: 540,
    slot: "answer",
    group: "Treatment",
  },
  {
    key: "library/clean-tray",
    path: "/assess/library/clean-tray.webp",
    alt: "Dental instruments on a tray with a sprig of mint",
    width: 720,
    height: 540,
    slot: "answer",
    group: "Practice",
  },
  {
    key: "library/front-desk-welcome",
    path: "/assess/library/front-desk-welcome.webp",
    alt: "A receptionist greeting a patient at the front desk",
    width: 720,
    height: 540,
    slot: "answer",
    group: "Practice",
  },
  // The lifestyle pictures below take the hero slot because that is the slot an
  // image BLOCK draws in (flow-block-view's imageViewFor asks for "hero"), not
  // because they are 1280 wide. They are not: they are tile-sized, and a screen
  // that stretches one edge to edge is showing a 720px picture, which is the
  // trade the size was chosen for.
  {
    key: "library/waiting-corner",
    path: "/assess/library/waiting-corner.webp",
    alt: "An armchair and side table in a waiting area",
    width: 720,
    height: 540,
    slot: "hero",
    group: "Practice",
  },
  {
    key: "library/gentle-care",
    path: "/assess/library/gentle-care.webp",
    alt: "A clinician adjusting the overhead light above a treatment chair",
    width: 720,
    height: 540,
    slot: "hero",
    group: "Practice",
  },
  {
    key: "library/stepping-out",
    path: "/assess/library/stepping-out.webp",
    alt: "A woman at the door of a dental practice on a high street",
    width: 720,
    height: 540,
    slot: "hero",
    group: "People",
  },
  // An abstract macro, so it is the one picture here with nobody in it and no
  // procedure being done: the screen to reach for when the copy above it is
  // doing the work and the picture should only set a tone. Same hero-slot,
  // tile-sized trade as the three above it.
  {
    key: "library/aligner-detail",
    path: "/assess/library/aligner-detail.webp",
    alt: "A close view of a clear aligner resting on a soft surface",
    width: 720,
    height: 540,
    slot: "hero",
    group: "Treatment",
  },
];

const BY_KEY = new Map(ASSESS_IMAGES.map((i) => [i.key, i]));

/** Every key, in manifest order. The picker's list. */
export const ASSESS_IMAGE_KEYS: readonly string[] = ASSESS_IMAGES.map((i) => i.key);

/**
 * Is this value a reference this build can resolve? Format first, then the map,
 * so a URL or a path never reaches the lookup at all.
 */
export function isAssessImageKey(value: unknown): value is string {
  return typeof value === "string" && KEY_FORMAT.test(value) && BY_KEY.has(value);
}

/** The manifest entry for a key, or undefined. Never throws, never guesses. */
export function assessImage(key: string | null | undefined): AssessImage | undefined {
  if (typeof key !== "string" || !KEY_FORMAT.test(key)) return undefined;
  return BY_KEY.get(key);
}

/**
 * The path a renderer may put in a src, or null. null is the safe answer: draw
 * nothing rather than a src the manifest cannot vouch for.
 */
export function assessImagePath(key: string | null | undefined): string | null {
  return assessImage(key)?.path ?? null;
}

/** Default alt for a key, or null. Same contract as assessImagePath. */
export function assessImageAlt(key: string | null | undefined): string | null {
  return assessImage(key)?.alt ?? null;
}

/** Everything fit for one slot, in manifest order. Drives the picker's tabs. */
export function assessImagesForSlot(slot: AssessImageSlot): AssessImage[] {
  return ASSESS_IMAGES.filter((i) => i.slot === slot);
}

/** Whether a key exists AND is fit for this slot (rule 13's second half). */
export function assessImageFitsSlot(key: string | null | undefined, slot: AssessImageSlot): boolean {
  return assessImage(key)?.slot === slot;
}
