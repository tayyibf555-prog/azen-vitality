// Deterministic COMPLIANCE lint for a landing-page content variant (schema v2).
//
// This is the hard, code-level gate that runs on every generated variant BEFORE
// it can be stored as usable. It mirrors the conversational agent's output
// guardrail (src/lib/agent/guardrail.ts): a prompt can ASK the model to stay
// compliant, but only a deterministic scanner can GUARANTEE that no banned
// pattern reaches a public, paid ad-destination page.
//
// Three layers:
//   1. Banned patterns  - UK GDC/ASA-sensitive wording a dental page must never
//      carry: testimonials/review language, guarantees, pain-free claims,
//      superlatives ("best", "No 1"), NHS/private/plan/band/funding words, and
//      the house-style symbol bans (em/en-dash, dollar sign).
//   2. Proof claims     - ratings, review counts, star language, awards and
//      press mentions ("as seen in") are OWNER-VERIFIED facts that render only
//      from practice configuration (PracticeFacts), NEVER from generated copy.
//      Any such wording inside content is rejected outright: there is no
//      legitimate way for the model to know these numbers/names.
//   3. Price cross-check - every advertised "from" price MUST exactly match the
//      practice's real catalogue price for that treatment. Invented prices are
//      the single highest-risk failure mode, so the real price list is injected
//      and enforced here rather than trusted from the model.
//
// British English, no em-dash. Conservative by design: err towards flagging.

import type { LandingPageContent } from "./content";
import { findTreatment } from "@/lib/treatments/catalog";

export type LintCategory =
  | "testimonial"
  | "guarantee"
  | "pain"
  | "superlative"
  | "funding"
  | "symbol"
  | "proof"
  | "price";

export interface LintFailure {
  category: LintCategory;
  /** The content field the failure was found in (e.g. "hero.headline"). */
  where: string;
  /** The offending phrase (or a short description for price failures). */
  matched: string;
}

export interface LintResult {
  ok: boolean;
  failures: LintFailure[];
}

// --- Testimonials / review language: never on a UK dental page. --------------
const TESTIMONIAL_PATTERNS: RegExp[] = [
  /\btestimonial(?:s)?\b/i,
  /\breview(?:s|ed)?\b/i,
  /\brated\b/i,
  /\brating\b/i,
  /\b(?:five|5)[ -]star(?:s)?\b/i,
  /\bstar rating\b/i,
  /\btrustpilot\b/i,
  /\bgoogle reviews?\b/i,
  /\bour patients (?:say|love|rave)\b/i,
  /\bwhat (?:our )?patients say\b/i,
  /\bloved by\b/i,
  /★/,
];

// --- Guarantees / absolute promises. -----------------------------------------
const GUARANTEE_PATTERNS: RegExp[] = [
  /\bguarantee(?:d|s)?\b/i,
  /\bwe promise\b/i,
  /\b100\s?%/,
  /\brisk[ -]free\b/i,
];

// --- Pain-free / painless claims. --------------------------------------------
const PAIN_PATTERNS: RegExp[] = [
  /\bpain[ -]?free\b/i,
  /\bpainless\b/i,
  /\bno pain\b/i,
  /\bwithout any pain\b/i,
];

// --- Superlatives, "best", "No 1" style claims. ------------------------------
const SUPERLATIVE_PATTERNS: RegExp[] = [
  /\bbest\b/i,
  /\bno\.? ?1\b/i,
  /\bnumber one\b/i,
  /#1\b/,
  /\bworld[ -]class\b/i,
  /\bleading\b/i,
  /\btop[ -]rated\b/i,
  /\bfinest\b/i,
  /\bunbeatable\b/i,
  /\bcheapest\b/i,
  /\blowest price(?:s)?\b/i,
  /\bthe most (?:trusted|advanced|experienced)\b/i,
];

// --- NHS / private / plan / band / funding wording. --------------------------
// Mirrors guardrail.ts FUNDING_PATTERNS, widened for marketing copy ("plan",
// "membership plan"). "private" is scoped to funding-ish usage so it does not
// catch benign words.
const FUNDING_PATTERNS: RegExp[] = [
  /\bnhs\b/i,
  /\bprivate (?:patient|treatment|price|fee|list|care|dentist|dentistry|band|cover|option|only)\b/i,
  /\b(?:on|go|going|as) (?:a )?private\b/i,
  /\bprivately\b/i,
  /\bfunding (?:type|category|band|option)\b/i,
  /\bband [123]\b/i,
  /\b(?:membership|dental|payment) plan\b/i,
];

// --- Symbols banned by house style. ------------------------------------------
const SYMBOL_PATTERNS: RegExp[] = [
  /[—–]/, // em-dash / en-dash
  /\$/, // dollar sign (GBP only)
];

// --- Proof claims: owner-verified facts only, never generated. ---------------
// Ratings/review-count/star language is largely covered by TESTIMONIAL_PATTERNS;
// this category adds awards, press and numeric-rating shapes. The renderer's
// proof row reads ONLY from PracticeFacts (practice configuration), so ANY
// occurrence inside generated content is an invented claim and is rejected.
const PROOF_PATTERNS: RegExp[] = [
  /\baward(?:s|ed)?[ -]?(?:winning)?\b/i,
  /\bas seen in\b/i,
  /\bfeatured in\b/i,
  /\bas featured\b/i,
  /\bin the press\b/i,
  /\bvoted\b/i,
  /\baccredited by\b/i,
  /\b\d(?:\.\d)?\s*(?:\/|out of)\s*5\b/i, // "4.9/5", "4.8 out of 5"
  /\b\d[\d,]*\+?\s*(?:happy|satisfied)\s+patients\b/i, // "10,000 happy patients"
];

const BANNED: { category: Exclude<LintCategory, "price">; patterns: RegExp[] }[] = [
  { category: "testimonial", patterns: TESTIMONIAL_PATTERNS },
  { category: "guarantee", patterns: GUARANTEE_PATTERNS },
  { category: "pain", patterns: PAIN_PATTERNS },
  { category: "superlative", patterns: SUPERLATIVE_PATTERNS },
  { category: "funding", patterns: FUNDING_PATTERNS },
  { category: "symbol", patterns: SYMBOL_PATTERNS },
  { category: "proof", patterns: PROOF_PATTERNS },
];

/** Flatten a v2 content object into (field-path, text) pairs for scanning. */
function textFields(content: LandingPageContent): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [
    { where: "hero.eyebrow", text: content.hero.eyebrow },
    { where: "hero.headline", text: content.hero.headline },
    { where: "hero.headlineAccent", text: content.hero.headlineAccent },
    { where: "hero.subhead", text: content.hero.subhead },
    { where: "painPoints.reassurance", text: content.painPoints.reassurance },
    { where: "about.body", text: content.about.body },
    { where: "suitability.heading", text: content.suitability.heading },
    { where: "pricing.caveat", text: content.pricing.caveat },
    { where: "cta.label", text: content.cta.label },
  ];
  content.hero.checklist.forEach((c, i) => {
    out.push({ where: `hero.checklist[${i}]`, text: c });
  });
  content.benefits.forEach((b, i) => {
    out.push({ where: `benefits[${i}].title`, text: b.title });
    out.push({ where: `benefits[${i}].detail`, text: b.detail });
  });
  content.painPoints.items.forEach((p, i) => {
    out.push({ where: `painPoints.items[${i}].title`, text: p.title });
    out.push({ where: `painPoints.items[${i}].body`, text: p.body });
  });
  content.about.keyFacts.forEach((f, i) => {
    out.push({ where: `about.keyFacts[${i}]`, text: f });
  });
  content.howItWorks.steps.forEach((s, i) => {
    out.push({ where: `howItWorks.steps[${i}].title`, text: s.title });
    out.push({ where: `howItWorks.steps[${i}].body`, text: s.body });
  });
  content.suitability.items.forEach((s, i) => {
    out.push({ where: `suitability.items[${i}].title`, text: s.title });
    out.push({ where: `suitability.items[${i}].body`, text: s.body });
  });
  content.pricing.lines.forEach((l, i) => {
    out.push({ where: `pricing.lines[${i}].treatment`, text: l.treatment });
  });
  content.faqs.forEach((f, i) => {
    out.push({ where: `faqs[${i}].q`, text: f.q });
    out.push({ where: `faqs[${i}].a`, text: f.a });
  });
  if (content.showcase3d) {
    out.push({ where: "showcase3d.caption", text: content.showcase3d.caption });
  }
  return out;
}

/**
 * Resolve a patient-facing treatment label to the practice's real "from" price in
 * GBP, or null when the label is not a known catalogue treatment. The default
 * implementation reads the single source of truth (treatments/catalog.ts); tests
 * inject a stub. Price is enforced against this, never trusted from the model.
 */
export type PriceResolver = (treatment: string) => number | null;

export const catalogPriceResolver: PriceResolver = (treatment) => {
  const t = findTreatment(treatment);
  return t ? t.priceFrom : null;
};

export interface LintOptions {
  /** Injected real-price lookup for the price cross-check. Defaults to the catalogue. */
  resolvePrice?: PriceResolver;
}

/**
 * Lint a content variant. Returns every failure (not just the first) so the
 * generation flow can quote them all back to the model on its single retry.
 */
export function lintContent(content: LandingPageContent, opts: LintOptions = {}): LintResult {
  const resolvePrice = opts.resolvePrice ?? catalogPriceResolver;
  const failures: LintFailure[] = [];

  // 1 + 2. Banned patterns (including proof claims) across every text field.
  for (const { where, text } of textFields(content)) {
    if (!text) continue;
    for (const { category, patterns } of BANNED) {
      for (const re of patterns) {
        const m = re.exec(text);
        if (m) failures.push({ category, where, matched: m[0] });
      }
    }
  }

  // 3. Price cross-check: every "from" price must exactly match the real price.
  content.pricing.lines.forEach((line, i) => {
    const real = resolvePrice(line.treatment);
    if (real === null) {
      failures.push({
        category: "price",
        where: `pricing.lines[${i}]`,
        matched: `unknown treatment "${line.treatment}" has no real price to verify against`,
      });
      return;
    }
    if (line.fromPriceGBP !== real) {
      failures.push({
        category: "price",
        where: `pricing.lines[${i}]`,
        matched: `"${line.treatment}" from-price £${line.fromPriceGBP} does not match the real price £${real}`,
      });
    }
  });

  return { ok: failures.length === 0, failures };
}

/** One-line, model-facing summary of the failures, for the regeneration prompt. */
export function describeFailures(failures: LintFailure[]): string {
  return failures.map((f) => `- [${f.category}] ${f.where}: ${f.matched}`).join("\n");
}

/** A single banned-pattern hit in a free-text scan (no price/field context). */
export interface BannedTextHit {
  category: Exclude<LintCategory, "price">;
  /** The offending phrase, as matched. */
  matched: string;
}

/**
 * Scan arbitrary free text against the SAME banned-pattern lists the landing lint
 * uses (testimonials, guarantees, pain-free claims, superlatives, funding wording,
 * banned symbols). No price cross-check (that needs field/structure context).
 *
 * This is the single source of truth for "which words are non-compliant for a UK
 * dental practice", reused by the creative-analysis compliance watch-outs so a
 * competitor's ad copy is scanned with exactly the same rules as our own pages.
 * Returns at most one hit per category (the first match) so callers can raise one
 * clear watch-out per issue.
 */
export function scanBannedText(text: string): BannedTextHit[] {
  const hits: BannedTextHit[] = [];
  if (!text) return hits;
  for (const { category, patterns } of BANNED) {
    for (const re of patterns) {
      const m = re.exec(text);
      if (m) {
        hits.push({ category, matched: m[0] });
        break; // one hit per category is enough for a watch-out
      }
    }
  }
  return hits;
}
