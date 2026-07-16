// Landing-page CONTENT schema + validator (pure TS, no I/O, no deps).
//
// A campaign landing page renders from a single vetted content object. Its shape
// is deliberately fixed and narrow: one hero, exactly three benefits, a pricing
// block, exactly three FAQs and one call to action. That fixed shape is what lets
// ONE server component render any generated variant safely (no free-form HTML from
// the model ever reaches the page), and it is what the compliance lint scans.
//
// British English, GBP, no em-dashes anywhere (the lint enforces the copy rules;
// this file only enforces SHAPE and length so a malformed model reply is rejected
// before it can be stored).

export type CtaTarget = "assessment" | "booking";

export interface Hero {
  headline: string;
  subhead: string;
}

export interface Benefit {
  title: string;
  detail: string;
}

export interface PricingLine {
  /** Patient-facing treatment label (cross-checked against the real catalogue price). */
  treatment: string;
  /** Indicative "from" price in GBP. Must match the practice's real price exactly. */
  fromPriceGBP: number;
}

export interface Pricing {
  lines: PricingLine[];
  /** The clinical-assessment caveat shown under the prices. */
  caveat: string;
}

export interface Faq {
  q: string;
  a: string;
}

export interface Cta {
  label: string;
  target: CtaTarget;
  /**
   * Optional slug of a specific downstream funnel (e.g. a Smile Assessment
   * campaign slug). Null means the generic funnel/booking page for the client.
   */
  targetSlug: string | null;
}

export interface LandingPageContent {
  hero: Hero;
  /** Exactly three. */
  benefits: Benefit[];
  pricing: Pricing;
  /** Exactly three. */
  faqs: Faq[];
  cta: Cta;
}

// Maximum lengths (characters). Kept generous enough for real copy but tight
// enough that an over-long or run-away model reply is rejected rather than stored.
export const LIMITS = {
  headline: 70,
  subhead: 160,
  benefitTitle: 40,
  benefitDetail: 160,
  pricingTreatment: 40,
  caveat: 200,
  faqQuestion: 120,
  faqAnswer: 320,
  ctaLabel: 40,
  targetSlug: 60,
  /** Guard against a line list padded out with invented treatments. */
  maxPricingLines: 4,
} as const;

export const CTA_TARGETS: readonly CtaTarget[] = ["assessment", "booking"];

export interface ValidationResult {
  ok: boolean;
  /** Present only when ok. The normalised (trimmed) content. */
  content?: LandingPageContent;
  /** Human-readable shape/length failures, quoted back to the model on retry. */
  errors: string[];
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A required, length-capped string field. Returns the trimmed value or pushes an error. */
function reqStr(
  errors: string[],
  where: string,
  raw: unknown,
  max: number,
): string {
  if (typeof raw !== "string") {
    errors.push(`${where} must be a string`);
    return "";
  }
  const s = raw.trim();
  if (s === "") {
    errors.push(`${where} must not be empty`);
    return "";
  }
  if (s.length > max) {
    errors.push(`${where} must be ${max} characters or fewer (got ${s.length})`);
  }
  return s;
}

/**
 * Validate + normalise a raw (parsed-JSON) value into a LandingPageContent.
 * Enforces the exact shape and the length limits only. Copy/compliance rules are
 * a SEPARATE deterministic lint (compliance.ts); the two run in sequence at
 * generation time. Returns every failure at once so a retry can quote them all.
 */
export function validateContent(raw: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObj(raw)) {
    return { ok: false, errors: ["content must be a JSON object"] };
  }

  // Hero.
  const heroRaw = raw.hero;
  const hero: Hero = { headline: "", subhead: "" };
  if (!isObj(heroRaw)) {
    errors.push("hero must be an object with headline and subhead");
  } else {
    hero.headline = reqStr(errors, "hero.headline", heroRaw.headline, LIMITS.headline);
    hero.subhead = reqStr(errors, "hero.subhead", heroRaw.subhead, LIMITS.subhead);
  }

  // Benefits (exactly three).
  const benefits: Benefit[] = [];
  if (!Array.isArray(raw.benefits)) {
    errors.push("benefits must be an array");
  } else if (raw.benefits.length !== 3) {
    errors.push(`benefits must contain exactly 3 items (got ${raw.benefits.length})`);
  } else {
    raw.benefits.forEach((b, i) => {
      if (!isObj(b)) {
        errors.push(`benefits[${i}] must be an object`);
        return;
      }
      benefits.push({
        title: reqStr(errors, `benefits[${i}].title`, b.title, LIMITS.benefitTitle),
        detail: reqStr(errors, `benefits[${i}].detail`, b.detail, LIMITS.benefitDetail),
      });
    });
  }

  // Pricing.
  const pricing: Pricing = { lines: [], caveat: "" };
  const pricingRaw = raw.pricing;
  if (!isObj(pricingRaw)) {
    errors.push("pricing must be an object with lines and caveat");
  } else {
    pricing.caveat = reqStr(errors, "pricing.caveat", pricingRaw.caveat, LIMITS.caveat);
    if (!Array.isArray(pricingRaw.lines)) {
      errors.push("pricing.lines must be an array");
    } else if (pricingRaw.lines.length < 1) {
      errors.push("pricing.lines must contain at least one line");
    } else if (pricingRaw.lines.length > LIMITS.maxPricingLines) {
      errors.push(`pricing.lines must contain ${LIMITS.maxPricingLines} lines or fewer`);
    } else {
      pricingRaw.lines.forEach((l, i) => {
        if (!isObj(l)) {
          errors.push(`pricing.lines[${i}] must be an object`);
          return;
        }
        const treatment = reqStr(
          errors,
          `pricing.lines[${i}].treatment`,
          l.treatment,
          LIMITS.pricingTreatment,
        );
        const price = l.fromPriceGBP;
        if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
          errors.push(`pricing.lines[${i}].fromPriceGBP must be a positive number`);
          pricing.lines.push({ treatment, fromPriceGBP: 0 });
        } else {
          pricing.lines.push({ treatment, fromPriceGBP: price });
        }
      });
    }
  }

  // FAQs (exactly three).
  const faqs: Faq[] = [];
  if (!Array.isArray(raw.faqs)) {
    errors.push("faqs must be an array");
  } else if (raw.faqs.length !== 3) {
    errors.push(`faqs must contain exactly 3 items (got ${raw.faqs.length})`);
  } else {
    raw.faqs.forEach((f, i) => {
      if (!isObj(f)) {
        errors.push(`faqs[${i}] must be an object`);
        return;
      }
      faqs.push({
        q: reqStr(errors, `faqs[${i}].q`, f.q, LIMITS.faqQuestion),
        a: reqStr(errors, `faqs[${i}].a`, f.a, LIMITS.faqAnswer),
      });
    });
  }

  // CTA.
  const cta: Cta = { label: "", target: "assessment", targetSlug: null };
  const ctaRaw = raw.cta;
  if (!isObj(ctaRaw)) {
    errors.push("cta must be an object with label, target and targetSlug");
  } else {
    cta.label = reqStr(errors, "cta.label", ctaRaw.label, LIMITS.ctaLabel);
    if (ctaRaw.target !== "assessment" && ctaRaw.target !== "booking") {
      errors.push("cta.target must be 'assessment' or 'booking'");
    } else {
      cta.target = ctaRaw.target;
    }
    // targetSlug is optional: null/absent is fine; a string is length-capped.
    if (ctaRaw.targetSlug === null || ctaRaw.targetSlug === undefined) {
      cta.targetSlug = null;
    } else if (typeof ctaRaw.targetSlug === "string") {
      const s = ctaRaw.targetSlug.trim();
      cta.targetSlug = s === "" ? null : s.slice(0, LIMITS.targetSlug);
    } else {
      errors.push("cta.targetSlug must be a string or null");
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, content: { hero, benefits, pricing, faqs, cta }, errors: [] };
}
