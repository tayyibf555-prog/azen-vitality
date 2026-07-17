// Landing-page CONTENT schema + validator (pure TS, no I/O, no deps).
//
// A campaign landing page renders from a single vetted content object. Its shape
// is deliberately fixed and narrow so that ONE server component can render any
// generated variant safely (no free-form HTML from the model ever reaches the
// page), and so the compliance lint has a known set of text fields to scan.
//
// SCHEMA v2 (this file). v2 is a full conversion-page shape modelled on a high
// performing competitor page, rendered in Vitality's LIGHT brand:
//   hero (eyebrow, accented headline, subhead, 4-item checklist)
//   benefits (3)         painPoints ("Sound familiar?", 4-6 + reassurance)
//   about (what-is + key facts)     howItWorks (4 numbered steps)
//   suitability (conditions / is-it-right-for-you, 4-6)
//   pricing              faqs (3-5)              cta
//   showcase3d           OPTIONAL, owner-configured only (a self-hosted 3D model)
//
// v1 rows (the seeded demo) carry only hero/benefits/pricing/faqs/cta. They are
// upgraded to v2 at READ time by a pure mapper (upgrade.ts) that fills the new
// sections from hand-written per-treatment defaults, so no DB migration is needed
// and old rows keep rendering.
//
// The validator here enforces SHAPE and LENGTH only, so a malformed model reply is
// rejected before it can be stored. Copy/compliance rules (banned wording, real
// price cross-check, owner-verified proof claims) are a SEPARATE deterministic
// lint (compliance.ts); the two run in sequence at generation time.
//
// British English, GBP, no em-dashes.

export type CtaTarget = "assessment" | "booking";

/** The current content schema version. Stamped onto validated content. */
export const CONTENT_VERSION = "2" as const;
export type ContentVersion = typeof CONTENT_VERSION;

export interface Hero {
  /** Small uppercase eyebrow line. Must never carry award/rating/press claims
   *  (those render only from owner-verified practiceFacts); the lint enforces it. */
  eyebrow: string;
  headline: string;
  /** The key, ideally quantified, benefit phrase to accent in the headline.
   *  Must appear verbatim (case-insensitive) inside `headline` so the renderer can
   *  highlight it in blue-royal. */
  headlineAccent: string;
  subhead: string;
  /** Exactly four short, ticked benefit phrases shown as a row under the hero. */
  checklist: string[];
}

export interface Benefit {
  title: string;
  detail: string;
}

/** A short titled card used by the empathy, how-it-works and suitability sections. */
export interface TitledCard {
  title: string;
  body: string;
}

export interface PainPoints {
  /** 4-6 empathetic "sound familiar?" cards. No clinical claims, no shaming. */
  items: TitledCard[];
  /** The closing reassurance line under the cards. */
  reassurance: string;
}

export interface About {
  /** Plain "what it is" paragraph. */
  body: string;
  /** 3-6 short key facts (from N months, removable, 0 percent finance, etc). */
  keyFacts: string[];
}

export interface HowItWorks {
  /** Exactly four numbered steps (01-04): consult, plan, treatment, result. */
  steps: TitledCard[];
}

export interface Suitability {
  /** Section heading: "Conditions we treat" (clinical) or "Is it right for you"
   *  (cosmetic). A short label, lint-scanned like every other text field. */
  heading: string;
  /** 4-6 condition / suitability cards. */
  items: TitledCard[];
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

/**
 * OPTIONAL 3D showcase. OWNER-CONFIGURED ONLY: the generator never produces this
 * (it is stripped in the generation vet path), and no default asset ships, so it
 * is absent unless a practice supplies a properly licensed, self-hosted model.
 * When absent the section is cleanly omitted; when the script or model fails to
 * load the renderer degrades to `posterUrl`.
 */
export interface Showcase3d {
  /** Local path to a self-hosted .glb under /public/models (never a remote URL). */
  modelUrl: string;
  /** Local path to a static poster image (fallback + loading state). */
  posterUrl: string;
  /** Short caption under the viewer. */
  caption: string;
}

export interface LandingPageContent {
  /** Schema version. Present on all validated/upgraded content. */
  version: ContentVersion;
  hero: Hero;
  /** Exactly three. */
  benefits: Benefit[];
  painPoints: PainPoints;
  about: About;
  howItWorks: HowItWorks;
  suitability: Suitability;
  pricing: Pricing;
  /** Three to five. */
  faqs: Faq[];
  cta: Cta;
  /** Optional, owner-configured 3D model section. Absent = omitted. */
  showcase3d?: Showcase3d | null;
}

// Maximum lengths (characters). Generous enough for real copy but tight enough
// that an over-long or run-away model reply is rejected rather than stored.
export const LIMITS = {
  eyebrow: 48,
  headline: 72,
  headlineAccent: 48,
  subhead: 170,
  checklistItem: 44,
  benefitTitle: 40,
  benefitDetail: 160,
  painTitle: 56,
  painBody: 170,
  painReassurance: 200,
  aboutBody: 520,
  keyFact: 90,
  stepTitle: 56,
  stepBody: 200,
  suitabilityHeading: 60,
  suitabilityTitle: 56,
  suitabilityBody: 200,
  pricingTreatment: 40,
  caveat: 200,
  faqQuestion: 120,
  faqAnswer: 320,
  ctaLabel: 40,
  targetSlug: 60,
  showcaseCaption: 120,
  url: 200,
  /** Guard against a line list padded out with invented treatments. */
  maxPricingLines: 4,
} as const;

// Fixed collection sizes. Exact where the layout depends on it (hero checklist,
// how-it-works steps); a small range where richer copy helps (pain points,
// key facts, suitability cards, faqs).
export const COUNTS = {
  checklist: 4,
  steps: 4,
  minPainPoints: 4,
  maxPainPoints: 6,
  minKeyFacts: 3,
  maxKeyFacts: 6,
  minSuitability: 4,
  maxSuitability: 6,
  minFaqs: 3,
  maxFaqs: 5,
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
function reqStr(errors: string[], where: string, raw: unknown, max: number): string {
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
 * A required array of non-empty, length-capped strings with a size bound. Returns
 * the trimmed values (pushing errors for any problem). `min === max` reads as an
 * exact-count requirement in the error message.
 */
function reqStrArray(
  errors: string[],
  where: string,
  raw: unknown,
  min: number,
  max: number,
  itemMax: number,
): string[] {
  if (!Array.isArray(raw)) {
    errors.push(`${where} must be an array`);
    return [];
  }
  if (raw.length < min || raw.length > max) {
    errors.push(
      min === max
        ? `${where} must contain exactly ${min} items (got ${raw.length})`
        : `${where} must contain between ${min} and ${max} items (got ${raw.length})`,
    );
  }
  return raw.map((v, i) => reqStr(errors, `${where}[${i}]`, v, itemMax));
}

/** A required array of {title, body} cards with a size bound. */
function reqCardArray(
  errors: string[],
  where: string,
  raw: unknown,
  min: number,
  max: number,
  titleMax: number,
  bodyMax: number,
): TitledCard[] {
  if (!Array.isArray(raw)) {
    errors.push(`${where} must be an array`);
    return [];
  }
  if (raw.length < min || raw.length > max) {
    errors.push(
      min === max
        ? `${where} must contain exactly ${min} items (got ${raw.length})`
        : `${where} must contain between ${min} and ${max} items (got ${raw.length})`,
    );
  }
  return raw.map((c, i) => {
    if (!isObj(c)) {
      errors.push(`${where}[${i}] must be an object with title and body`);
      return { title: "", body: "" };
    }
    return {
      title: reqStr(errors, `${where}[${i}].title`, c.title, titleMax),
      body: reqStr(errors, `${where}[${i}].body`, c.body, bodyMax),
    };
  });
}

/** Validate an optional showcase3d section. Undefined/null -> null (omitted). */
function validateShowcase(errors: string[], raw: unknown): Showcase3d | null {
  if (raw === undefined || raw === null) return null;
  if (!isObj(raw)) {
    errors.push("showcase3d must be an object or null");
    return null;
  }
  const modelUrl = reqStr(errors, "showcase3d.modelUrl", raw.modelUrl, LIMITS.url);
  const posterUrl = reqStr(errors, "showcase3d.posterUrl", raw.posterUrl, LIMITS.url);
  const caption = reqStr(errors, "showcase3d.caption", raw.caption, LIMITS.showcaseCaption);
  // Local paths only: never load a remote model/poster onto a public page.
  if (modelUrl && !modelUrl.startsWith("/")) {
    errors.push("showcase3d.modelUrl must be a local path starting with '/'");
  }
  if (modelUrl && !/\.glb$/i.test(modelUrl)) {
    errors.push("showcase3d.modelUrl must point to a .glb file");
  }
  if (posterUrl && !posterUrl.startsWith("/")) {
    errors.push("showcase3d.posterUrl must be a local path starting with '/'");
  }
  return { modelUrl, posterUrl, caption };
}

/**
 * Validate + normalise a raw (parsed-JSON) value into a v2 LandingPageContent.
 * Enforces the exact shape and the length limits only. Returns every failure at
 * once so a retry can quote them all. Stamps `version` and never trusts a caller
 * supplied version. `showcase3d` is validated when present but is owner-only in
 * practice (the generation vet path strips it).
 */
export function validateContent(raw: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObj(raw)) {
    return { ok: false, errors: ["content must be a JSON object"] };
  }

  // Hero.
  const hero: Hero = { eyebrow: "", headline: "", headlineAccent: "", subhead: "", checklist: [] };
  const heroRaw = raw.hero;
  if (!isObj(heroRaw)) {
    errors.push("hero must be an object with eyebrow, headline, headlineAccent, subhead and checklist");
  } else {
    hero.eyebrow = reqStr(errors, "hero.eyebrow", heroRaw.eyebrow, LIMITS.eyebrow);
    hero.headline = reqStr(errors, "hero.headline", heroRaw.headline, LIMITS.headline);
    hero.headlineAccent = reqStr(errors, "hero.headlineAccent", heroRaw.headlineAccent, LIMITS.headlineAccent);
    hero.subhead = reqStr(errors, "hero.subhead", heroRaw.subhead, LIMITS.subhead);
    hero.checklist = reqStrArray(
      errors,
      "hero.checklist",
      heroRaw.checklist,
      COUNTS.checklist,
      COUNTS.checklist,
      LIMITS.checklistItem,
    );
    // The accent must be a real substring of the headline so it can be highlighted.
    if (
      hero.headline &&
      hero.headlineAccent &&
      !hero.headline.toLowerCase().includes(hero.headlineAccent.toLowerCase())
    ) {
      errors.push("hero.headlineAccent must appear verbatim inside hero.headline");
    }
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

  // Pain points ("Sound familiar?").
  const painPoints: PainPoints = { items: [], reassurance: "" };
  const painRaw = raw.painPoints;
  if (!isObj(painRaw)) {
    errors.push("painPoints must be an object with items and reassurance");
  } else {
    painPoints.items = reqCardArray(
      errors,
      "painPoints.items",
      painRaw.items,
      COUNTS.minPainPoints,
      COUNTS.maxPainPoints,
      LIMITS.painTitle,
      LIMITS.painBody,
    );
    painPoints.reassurance = reqStr(errors, "painPoints.reassurance", painRaw.reassurance, LIMITS.painReassurance);
  }

  // About the treatment.
  const about: About = { body: "", keyFacts: [] };
  const aboutRaw = raw.about;
  if (!isObj(aboutRaw)) {
    errors.push("about must be an object with body and keyFacts");
  } else {
    about.body = reqStr(errors, "about.body", aboutRaw.body, LIMITS.aboutBody);
    about.keyFacts = reqStrArray(
      errors,
      "about.keyFacts",
      aboutRaw.keyFacts,
      COUNTS.minKeyFacts,
      COUNTS.maxKeyFacts,
      LIMITS.keyFact,
    );
  }

  // How it works (exactly four steps).
  const howItWorks: HowItWorks = { steps: [] };
  const howRaw = raw.howItWorks;
  if (!isObj(howRaw)) {
    errors.push("howItWorks must be an object with steps");
  } else {
    howItWorks.steps = reqCardArray(
      errors,
      "howItWorks.steps",
      howRaw.steps,
      COUNTS.steps,
      COUNTS.steps,
      LIMITS.stepTitle,
      LIMITS.stepBody,
    );
  }

  // Suitability / conditions.
  const suitability: Suitability = { heading: "", items: [] };
  const suitRaw = raw.suitability;
  if (!isObj(suitRaw)) {
    errors.push("suitability must be an object with heading and items");
  } else {
    suitability.heading = reqStr(errors, "suitability.heading", suitRaw.heading, LIMITS.suitabilityHeading);
    suitability.items = reqCardArray(
      errors,
      "suitability.items",
      suitRaw.items,
      COUNTS.minSuitability,
      COUNTS.maxSuitability,
      LIMITS.suitabilityTitle,
      LIMITS.suitabilityBody,
    );
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
        const treatment = reqStr(errors, `pricing.lines[${i}].treatment`, l.treatment, LIMITS.pricingTreatment);
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

  // FAQs (three to five).
  const faqs: Faq[] = [];
  if (!Array.isArray(raw.faqs)) {
    errors.push("faqs must be an array");
  } else if (raw.faqs.length < COUNTS.minFaqs || raw.faqs.length > COUNTS.maxFaqs) {
    errors.push(`faqs must contain between ${COUNTS.minFaqs} and ${COUNTS.maxFaqs} items (got ${raw.faqs.length})`);
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

  // Showcase (optional). Validated when present; owner-only in practice.
  const showcase3d = validateShowcase(errors, raw.showcase3d);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    content: {
      version: CONTENT_VERSION,
      hero,
      benefits,
      painPoints,
      about,
      howItWorks,
      suitability,
      pricing,
      faqs,
      cta,
      showcase3d,
    },
    errors: [],
  };
}
