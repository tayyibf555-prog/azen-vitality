// Prompt builders + response parsing for AI landing-page generation (schema v2).
// Pure (no network), so the routes stay thin and the prompts are unit-testable.
//
// Two variants are generated per page from two distinct creative directions
// (confidence-led vs value-led), so the split test compares genuinely different
// angles rather than two rewordings. Every prompt bakes in the UK GDC/ASA rules
// and the REAL catalogue price line, so a compliant reply is the path of least
// resistance; the deterministic lint is still the hard gate afterwards.
//
// v2 additions the prompt must hold the line on:
//   - the model writes the FULL conversion-page sections (hero with accent +
//     checklist, pain points, about, how-it-works, suitability, 3-5 faqs)
//   - it must NEVER invent proof claims: no ratings, review counts, stars,
//     awards, press names ("as seen in"). Those render only from owner-verified
//     practice configuration, outside the generated content.
//   - it must NEVER emit a showcase3d section. 3D is owner-configured only.
//
// British English, GBP, no em-dashes.

import type { CtaTarget, LandingPageContent, PricingLine } from "./content";
import { LIMITS, COUNTS } from "./content";
import { getDefaultContent } from "./defaults";
import type { Treatment } from "@/lib/treatments/catalog";

export type DirectionKey = "a" | "b";

export interface CreativeDirection {
  key: DirectionKey;
  name: string;
  brief: string;
}

// The two creative directions. Kept deliberately different so A/B is meaningful.
export const CREATIVE_DIRECTIONS: Record<DirectionKey, CreativeDirection> = {
  a: {
    key: "a",
    name: "confidence-led",
    brief:
      "Lead with the emotional outcome: how the patient will feel, warmth and reassurance, a calm and welcoming tone. Speak to their real motivation, not clinical detail.",
  },
  b: {
    key: "b",
    name: "value-led",
    brief:
      "Lead with practicality and value: what is included, spreading the cost where finance is offered, the free or low-commitment first step, and clear, honest expectations.",
  },
};

const HOUSE_RULES = [
  "British English. Money in GBP with the £ symbol. Never use an em-dash or en-dash; use commas, full stops or brackets.",
  "This is for a single UK dental practice.",
].join(" ");

// The UK GDC/ASA copy rules, stated so the model writes compliant copy first time.
const COMPLIANCE_RULES = [
  "No patient testimonials, reviews, ratings or star language of any kind.",
  "No invented proof claims: never mention a Google rating, a review count, awards, 'award winning', being featured or seen in any publication, or patient numbers. Verified practice facts are displayed separately by the system; your copy must not contain any.",
  "No guarantees, promises or absolute claims (no 'guaranteed', 'risk free', '100%').",
  "No 'pain free' or 'painless' claims.",
  "No superlatives or ranking claims ('best', 'No 1', 'leading', 'world class', 'cheapest').",
  "Never mention NHS, private, funding, plans, membership or charge bands.",
  "Prices must be shown ONLY as the exact 'from' price provided, with the clinical-assessment caveat.",
  "Make clear that treatment suitability always depends on a clinical assessment.",
  "Pain-point cards must be empathetic everyday frustrations, never shaming and never clinical claims or diagnoses.",
].join(" ");

/** The single allowed price line for a treatment, from the catalogue (source of truth). */
export function focusPriceLine(t: Treatment): PricingLine {
  return { treatment: t.name, fromPriceGBP: t.priceFrom };
}

// Exemplar pool (guaranteed lint-clean v2 defaults). We show a couple as
// references of tone and structure, excluding the focus treatment so the model
// does not simply copy a default verbatim. Two exemplars (not three) because a
// full v2 object is much larger than v1; two is enough to pin tone + shape.
const EXEMPLAR_KEYS = ["invisalign", "veneers", "hygiene", "whitening"] as const;

/** Strip the fields the model must not echo (version, showcase3d) from an exemplar. */
function exemplarView(c: LandingPageContent): Omit<LandingPageContent, "version" | "showcase3d"> {
  const { version: _version, showcase3d: _showcase3d, ...rest } = c;
  return rest;
}

function exemplarsFor(focusKey: string): Omit<LandingPageContent, "version" | "showcase3d">[] {
  return EXEMPLAR_KEYS.filter((k) => k !== focusKey)
    .slice(0, 2)
    .map((k) => getDefaultContent(k, "booking"))
    .filter((c): c is LandingPageContent => c !== null)
    .map(exemplarView);
}

export interface VariantPromptInput {
  direction: CreativeDirection;
  treatment: Treatment;
  practiceName: string;
  ctaTarget: CtaTarget;
  /** Optional owner notes on angle / audience. */
  angle?: string;
}

const SHAPE_INSTRUCTION = [
  "Respond with ONLY a JSON object of exactly this shape (no extra keys, no showcase3d key):",
  '{"hero":{"eyebrow":"...","headline":"...","headlineAccent":"...","subhead":"...","checklist":["...","...","...","..."]},',
  '"benefits":[{"title":"...","detail":"..."},{"title":"...","detail":"..."},{"title":"...","detail":"..."}],',
  '"painPoints":{"items":[{"title":"...","body":"..."},...],"reassurance":"..."},',
  '"about":{"body":"...","keyFacts":["...","..."]},',
  '"howItWorks":{"steps":[{"title":"...","body":"..."},{"title":"...","body":"..."},{"title":"...","body":"..."},{"title":"...","body":"..."}]},',
  '"suitability":{"heading":"...","items":[{"title":"...","body":"..."},...]},',
  '"pricing":{"lines":[{"treatment":"...","fromPriceGBP":0}],"caveat":"..."},',
  '"faqs":[{"q":"...","a":"..."},...],',
  '"cta":{"label":"...","target":"...","targetSlug":null}}',
  "Counts and rules:",
  `- hero.checklist: exactly ${COUNTS.checklist} short ticked phrases (<= ${LIMITS.checklistItem} chars each).`,
  `- hero.headlineAccent: the key quantified benefit phrase, and it MUST appear verbatim inside hero.headline (it is highlighted in colour). Example: headline 'Straighter teeth, no metal braces, from 3 months' with headlineAccent 'from 3 months'.`,
  `- benefits: exactly 3. painPoints.items: ${COUNTS.minPainPoints} to ${COUNTS.maxPainPoints} empathetic everyday frustrations.`,
  `- about.keyFacts: ${COUNTS.minKeyFacts} to ${COUNTS.maxKeyFacts} short facts. howItWorks.steps: exactly ${COUNTS.steps} (consultation with scan, custom plan, treatment, result and retention; adapt the wording to the treatment).`,
  `- suitability: for clinical treatments use a 'what it can help with' heading and condition cards (crowded teeth, gaps, and so on, explained factually); for cosmetic treatments use an 'is it right for you' heading and suitability cards. ${COUNTS.minSuitability} to ${COUNTS.maxSuitability} items.`,
  `- faqs: ${COUNTS.minFaqs} to ${COUNTS.maxFaqs}.`,
  `Length caps (chars): eyebrow <= ${LIMITS.eyebrow}, headline <= ${LIMITS.headline}, headlineAccent <= ${LIMITS.headlineAccent}, subhead <= ${LIMITS.subhead}, benefit title <= ${LIMITS.benefitTitle}, benefit detail <= ${LIMITS.benefitDetail}, pain title <= ${LIMITS.painTitle}, pain body <= ${LIMITS.painBody}, reassurance <= ${LIMITS.painReassurance}, about body <= ${LIMITS.aboutBody}, key fact <= ${LIMITS.keyFact}, step title <= ${LIMITS.stepTitle}, step body <= ${LIMITS.stepBody}, suitability heading <= ${LIMITS.suitabilityHeading}, suitability title <= ${LIMITS.suitabilityTitle}, suitability body <= ${LIMITS.suitabilityBody}, faq answer <= ${LIMITS.faqAnswer}, cta label <= ${LIMITS.ctaLabel}.`,
  "Do not use double-quote characters inside any string value (it breaks the JSON); use single quotes if you must quote.",
].join("\n");

/** Build the system + user prompt for ONE variant. */
export function buildVariantPrompt(input: VariantPromptInput): { system: string; user: string } {
  const { direction, treatment, practiceName, ctaTarget, angle } = input;
  const line = focusPriceLine(treatment);

  const system = [
    `You are an expert UK dental marketing copywriter writing a full conversion landing page for ${practiceName}.`,
    `The page is for one treatment: ${treatment.name}.`,
    `Creative direction for THIS variant (${direction.name}): ${direction.brief}`,
    "UK advertising rules for dentists (GDC and ASA/CAP) that you MUST follow:",
    COMPLIANCE_RULES,
    HOUSE_RULES,
    `Use ONLY this exact price line, unchanged, in pricing.lines: treatment "${line.treatment}", fromPriceGBP ${line.fromPriceGBP}. Do not invent or alter any price.`,
    `Set cta.target to exactly "${ctaTarget}" and cta.targetSlug to null. Write a short, action-led cta.label.`,
    "Here are reference pages for tone and structure (do not copy them; write fresh copy for this treatment):",
    exemplarsFor(treatment.key)
      .map((e, i) => `Reference ${i + 1}: ${JSON.stringify(e)}`)
      .join("\n"),
    SHAPE_INSTRUCTION,
  ].join("\n");

  const uspLine = treatment.usp ? `Practice selling point to weave in honestly: ${treatment.usp}` : "";
  const financeLine = treatment.financeAvailable
    ? "Finance (0 percent or spread payments) is available for this treatment and may be mentioned."
    : "Finance is NOT offered for this treatment; do not mention finance or spreading the cost.";

  const user = [
    `Treatment: ${treatment.name}. ${treatment.summary}`,
    `Typical visits: ${treatment.typicalVisits}.`,
    financeLine,
    uspLine,
    angle ? `Owner notes on angle / audience: ${angle}` : "Angle: choose the most persuasive compliant angle for this direction.",
  ]
    .filter(Boolean)
    .join("\n");

  return { system, user };
}

/** Build the user message for the single regeneration retry, quoting the failures. */
export function buildRetryUser(previousReply: string, failuresText: string): string {
  return [
    "Your previous reply did not pass our compliance and shape checks.",
    "Fix EVERY issue below and return the corrected JSON object only, same shape as before:",
    failuresText,
    "",
    "Your previous reply was:",
    previousReply,
  ].join("\n");
}

// Em/en dashes never appear in JSON structural syntax, so replacing them across the
// whole extracted string only touches copy inside values. This normalises the one
// house-style symbol the model most often slips in, reducing needless retries; the
// lint still catches anything else.
function normaliseDashes(s: string): string {
  return s.replace(/[—–]/g, ", ");
}

/**
 * Extract and parse the JSON content object from a model reply. Returns the parsed
 * (unknown) value for the validator, or null when no JSON object can be read.
 */
export function parseContentJson(text: string): unknown | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(normaliseDashes(match[0]));
  } catch {
    return null;
  }
}
