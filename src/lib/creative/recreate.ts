// Brand-true PROMPT builder for the "recreate this ad with your branding" flow.
//
// Pure and deterministic (no network, no React) so it is easy to unit test and so the
// final prompt can be run through the compliance lint (scanBannedText) BEFORE it is
// ever sent to Higgsfield. Every input is a REAL practice fact: the practice name, its
// real locations, the real treatment, the real catalogue "from" price (only when the
// owner opts to show it), and the brand colours. It NEVER invents a claim, a
// testimonial, a rating or a fake patient.
//
// IMPORTANT: this text is scanned verbatim by scanBannedText, so the copy here is
// written to contain ZERO banned tokens. The compliance instructions are phrased
// WITHOUT the banned words themselves (e.g. we say "avoid any promise of a specific
// result", never "no guarantees"), because the scanner is a blunt word match that does
// not understand negation. British English, no dash characters.

import type { AdFormat } from "@/lib/meta-ads/types";
import { aspectRatioForFormat } from "@/lib/higgsfield/client";

/**
 * The practice brand colours, most important first. These are the platform blues today
 * (a considered placeholder), because the practice's own brand palette is not captured
 * in configuration yet. Values are the real design tokens (--blue-royal, --blue-dark).
 */
export const PLACEHOLDER_BRAND_COLOURS = ["#16559a", "#2379ab"];

export interface RecreatePromptInput {
  /** The practice name, e.g. "Vitality Dental". */
  practiceName: string;
  /** Brand colours as hex/CSS strings, most important first. */
  brandColours: string[];
  /** Human locations line (from PracticeFacts), or null to omit. */
  locationsLine?: string | null;
  /** The real, patient-facing treatment name, e.g. "Teeth whitening". */
  treatmentName: string;
  /** The real catalogue "from" price in GBP, or null when unknown/not shown. */
  fromPriceGBP?: number | null;
  /** The creative angle from the source ad (e.g. its hook type). */
  angle: string;
  /** Optional extra angle notes typed by the owner (linted downstream). */
  angleNotes?: string;
  /** The source ad's format, which drives the aspect ratio. */
  format: AdFormat;
  /** Whether to include the real "from" price as an on-image caption. Default false. */
  includeFromPrice?: boolean;
}

/**
 * Build the brand-true image prompt. The result is a single string ready to be linted
 * and (once configured) sent to Higgsfield.
 */
export function buildRecreatePrompt(input: RecreatePromptInput): string {
  const {
    practiceName,
    brandColours,
    locationsLine,
    treatmentName,
    fromPriceGBP,
    angle,
    angleNotes,
    format,
    includeFromPrice,
  } = input;

  const locationsClause = locationsLine ? ` in ${locationsLine}` : "";
  const coloursClause = brandColours.length ? brandColours.join(", ") : "a calm, professional blue";
  const angleClause = [angle, angleNotes].map((s) => s?.trim()).filter(Boolean).join("; ");
  const aspectRatio = aspectRatioForFormat(format);

  // Only ever the REAL catalogue figure, and only when the owner opts in.
  const showPrice = Boolean(includeFromPrice) && typeof fromPriceGBP === "number";
  const priceClause = showPrice
    ? `, other than a single small, clearly legible caption reading From £${fromPriceGBP}`
    : "";

  return [
    `Create a polished, professional marketing photograph for ${practiceName}, a UK dental practice${locationsClause}.`,
    `Subject: ${treatmentName}.`,
    angleClause ? `Creative angle: ${angleClause}.` : null,
    `Visual direction: a bright, welcoming, contemporary dental studio scene that feels calm and reassuring. Use natural, soft light and a clean, uncluttered composition. Weave the practice brand colours (${coloursClause}) through tasteful accents such as walls, uniforms or props, kept subtle.`,
    `People and honesty: if a person appears, use a generic, friendly model in an ordinary, everyday moment. Never present anyone as a named or actual patient, and never imply a personal story. Do not show a before and after comparison, and avoid implying any specific clinical result.`,
    `Keep the frame free of logos, badges, icons, numeric scores and written slogans${priceClause}.`,
    `Output: photorealistic, editorial quality, ${aspectRatio} composition, suitable for a paid social ad.`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
