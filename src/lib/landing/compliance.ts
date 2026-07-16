// Deterministic COMPLIANCE lint for a landing-page content variant.
//
// This is the hard, code-level gate that runs on every generated variant BEFORE
// it can be stored as usable. It mirrors the conversational agent's output
// guardrail (src/lib/agent/guardrail.ts): a prompt can ASK the model to stay
// compliant, but only a deterministic scanner can GUARANTEE that no banned
// pattern reaches a public, paid ad-destination page.
//
// Two layers:
//   1. Banned patterns  - UK GDC/ASA-sensitive wording a dental page must never
//      carry: testimonials/review language, guarantees, pain-free claims,
//      superlatives ("best", "No 1"), NHS/private/plan/band/funding words, and
//      the house-style symbol bans (em/en-dash, dollar sign).
//   2. Price cross-check - every advertised "from" price MUST exactly match the
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

const BANNED: { category: Exclude<LintCategory, "price">; patterns: RegExp[] }[] = [
  { category: "testimonial", patterns: TESTIMONIAL_PATTERNS },
  { category: "guarantee", patterns: GUARANTEE_PATTERNS },
  { category: "pain", patterns: PAIN_PATTERNS },
  { category: "superlative", patterns: SUPERLATIVE_PATTERNS },
  { category: "funding", patterns: FUNDING_PATTERNS },
  { category: "symbol", patterns: SYMBOL_PATTERNS },
];

/** Flatten a content object into (field-path, text) pairs for scanning. */
function textFields(content: LandingPageContent): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [
    { where: "hero.headline", text: content.hero.headline },
    { where: "hero.subhead", text: content.hero.subhead },
    { where: "pricing.caveat", text: content.pricing.caveat },
    { where: "cta.label", text: content.cta.label },
  ];
  content.benefits.forEach((b, i) => {
    out.push({ where: `benefits[${i}].title`, text: b.title });
    out.push({ where: `benefits[${i}].detail`, text: b.detail });
  });
  content.pricing.lines.forEach((l, i) => {
    out.push({ where: `pricing.lines[${i}].treatment`, text: l.treatment });
  });
  content.faqs.forEach((f, i) => {
    out.push({ where: `faqs[${i}].q`, text: f.q });
    out.push({ where: `faqs[${i}].a`, text: f.a });
  });
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

  // 1. Banned patterns across every text field.
  for (const { where, text } of textFields(content)) {
    if (!text) continue;
    for (const { category, patterns } of BANNED) {
      for (const re of patterns) {
        const m = re.exec(text);
        if (m) failures.push({ category, where, matched: m[0] });
      }
    }
  }

  // 2. Price cross-check: every "from" price must exactly match the real price.
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
