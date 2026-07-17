// PURE v1 -> v2 content upgrade mapper, applied at READ time.
//
// Existing landing_page_variant rows (e.g. the seeded /go/vitality/invisalign-demo
// demo) were stored in schema v1: hero {headline, subhead} + benefits + pricing +
// faqs + cta only. Schema v2 (content.ts) adds the full conversion-page sections.
// Rather than migrating stored jsonb (risky for a live public page), every read
// path maps a v1 object up to v2 here, filling the NEW sections from the
// hand-written, lint-clean per-treatment defaults (defaults.ts) while PRESERVING
// the row's own generated copy for the sections v1 already had.
//
// Guarantees:
//   - pure function, no I/O; deterministic for a given (raw, treatmentKey)
//   - output always passes validateContent (shape) for well-formed v1 input
//   - the filled sections are lint-clean by construction (they come from the
//     defaults, which the compliance tests pin as clean)
//   - v2 input passes through unchanged (idempotent)
//   - never invents proof claims: filled sections carry none, and showcase3d is
//     never added (it stays owner-configured only)
//
// British English, GBP, no em-dashes.

import type { CtaTarget, LandingPageContent, TitledCard } from "./content";
import { CONTENT_VERSION } from "./content";
import { getDefaultContent, hasDefaultContent } from "./defaults";

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** True when a stored content object is already schema v2. */
export function isV2Content(raw: unknown): raw is LandingPageContent {
  return isObj(raw) && raw.version === CONTENT_VERSION;
}

// --- Generic fallback sections -----------------------------------------------
// Used only when a v1 row's treatment has no hand-written default (should not
// happen for pages created through the UI, which is limited to the six default
// treatments, but a read path must never throw). Deliberately treatment-neutral,
// GDC/ASA-safe wording; lint-clean by construction (pinned by upgrade.test.ts).

const GENERIC = {
  eyebrow: "Your smile, looked after",
  checklist: [
    "A friendly, unrushed team",
    "Clear guidance on your options",
    "Transparent from prices",
    "GDC registered dentists",
  ],
  painPoints: {
    items: [
      { title: "Putting it off", body: "You have been meaning to look into this for a while but never quite got round to it." },
      { title: "Not sure of your options", body: "It is hard to know what would suit you without a proper conversation." },
      { title: "Worried about cost", body: "You would like clear, honest pricing before you commit to anything." },
      { title: "Short on time", body: "You need appointments that fit around work and family life." },
    ] as TitledCard[],
    reassurance: "Whatever brings you here, the first step is a simple conversation with our team.",
  },
  about: {
    body:
      "Every treatment starts with a proper conversation. We listen to what you would like to change, examine your teeth and gums, and explain your options clearly, including what is involved and what it costs, so you can decide in your own time.",
    keyFacts: [
      "A clear, personal treatment plan",
      "Transparent from prices",
      "Appointments that fit around you",
    ],
  },
  howItWorks: {
    steps: [
      { title: "Consultation", body: "We talk through your goals and take a careful look at your teeth and gums." },
      { title: "Your plan", body: "Your dentist explains your options and sets out a clear plan with honest pricing." },
      { title: "Your treatment", body: "Treatment goes ahead at your pace, with the team supporting you at each visit." },
      { title: "Aftercare", body: "We help you keep the result looking and feeling good with simple aftercare advice." },
    ] as TitledCard[],
  },
  suitability: {
    heading: "Is this right for you",
    items: [
      { title: "You want a change", body: "Something about your smile has been on your mind and you would like it looked at." },
      { title: "You want clear answers", body: "You would like a professional opinion on what is possible for you." },
      { title: "You want honest pricing", body: "You want to know the costs up front before deciding anything." },
      { title: "You want it done properly", body: "You are looking for careful, unhurried treatment from a GDC registered team." },
    ] as TitledCard[],
  },
} as const;

function nonEmptyStr(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/** v1 benefits: exactly three {title, detail} string pairs, or null. */
function coerceBenefits(raw: unknown): LandingPageContent["benefits"] | null {
  if (!Array.isArray(raw) || raw.length !== 3) return null;
  const out: LandingPageContent["benefits"] = [];
  for (const b of raw) {
    if (!isObj(b) || !nonEmptyStr(b.title) || !nonEmptyStr(b.detail)) return null;
    out.push({ title: b.title.trim(), detail: b.detail.trim() });
  }
  return out;
}

/** v1 pricing: {lines: [{treatment, fromPriceGBP}...], caveat}, or null. */
function coercePricing(raw: unknown): LandingPageContent["pricing"] | null {
  if (!isObj(raw) || !nonEmptyStr(raw.caveat) || !Array.isArray(raw.lines) || raw.lines.length === 0) {
    return null;
  }
  const lines: LandingPageContent["pricing"]["lines"] = [];
  for (const l of raw.lines) {
    if (!isObj(l) || !nonEmptyStr(l.treatment)) return null;
    const price = l.fromPriceGBP;
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return null;
    lines.push({ treatment: l.treatment.trim(), fromPriceGBP: price });
  }
  return { lines, caveat: raw.caveat.trim() };
}

/** v1 faqs: three to five {q, a} string pairs, or null. */
function coerceFaqs(raw: unknown): LandingPageContent["faqs"] | null {
  if (!Array.isArray(raw) || raw.length < 3 || raw.length > 5) return null;
  const out: LandingPageContent["faqs"] = [];
  for (const f of raw) {
    if (!isObj(f) || !nonEmptyStr(f.q) || !nonEmptyStr(f.a)) return null;
    out.push({ q: f.q.trim(), a: f.a.trim() });
  }
  return out;
}

/** v1 cta: {label, target 'assessment'|'booking', targetSlug string|null}, or null. */
function coerceCta(raw: unknown): LandingPageContent["cta"] | null {
  if (!isObj(raw) || !nonEmptyStr(raw.label)) return null;
  if (raw.target !== "assessment" && raw.target !== "booking") return null;
  const targetSlug = nonEmptyStr(raw.targetSlug) ? raw.targetSlug.trim() : null;
  return { label: raw.label.trim(), target: raw.target, targetSlug };
}

/**
 * Derive a headlineAccent that is GUARANTEED to be a substring of the given
 * headline (the v2 validator requires it):
 *   1. the treatment default's accent, when it already appears in the headline
 *   2. otherwise the final word of the headline (punctuation trimmed)
 *   3. otherwise the whole headline (single-word or degenerate cases)
 */
export function deriveAccent(headline: string, preferredAccent: string | null): string {
  const h = headline.trim();
  if (preferredAccent && h.toLowerCase().includes(preferredAccent.toLowerCase())) {
    return preferredAccent;
  }
  const words = h.split(/\s+/).filter(Boolean);
  const last = words[words.length - 1]?.replace(/[^\p{L}\p{N}£%]+$/u, "") ?? "";
  if (last && h.toLowerCase().includes(last.toLowerCase())) return last;
  return h;
}

/**
 * Upgrade a stored content object to schema v2.
 * - v2 input is returned as-is (idempotent; showcase3d preserved).
 * - v1 input keeps its own hero headline/subhead, benefits, pricing, faqs and cta,
 *   and gains eyebrow/accent/checklist/painPoints/about/howItWorks/suitability
 *   from the treatment's hand-written default (generic fallback when unknown).
 * - Malformed input is returned as the treatment default (assessment CTA) so a
 *   public read path never throws; the validator still guards writes.
 */
export function upgradeContent(raw: unknown, treatmentKey: string): LandingPageContent {
  if (isV2Content(raw)) return raw;

  const fallbackTarget: CtaTarget = "assessment";
  const base = hasDefaultContent(treatmentKey)
    ? getDefaultContent(treatmentKey, fallbackTarget)
    : null;

  if (!isObj(raw)) {
    // Unreadable row: serve the guaranteed-clean default rather than throwing.
    return base ?? genericContent(fallbackTarget);
  }

  const template = base ?? genericContent(fallbackTarget);

  // ---- hero: keep the row's headline/subhead, fill the rest ----
  const heroRaw = isObj(raw.hero) ? raw.hero : {};
  const headline =
    typeof heroRaw.headline === "string" && heroRaw.headline.trim() !== ""
      ? heroRaw.headline.trim()
      : template.hero.headline;
  const subhead =
    typeof heroRaw.subhead === "string" && heroRaw.subhead.trim() !== ""
      ? heroRaw.subhead.trim()
      : template.hero.subhead;

  // ---- benefits / pricing / faqs / cta: keep the row's own copy when present
  // (structurally checked, not blind-cast; anything off falls back to the
  // template so the output is always genuinely v2-valid) ----
  const benefits = coerceBenefits(raw.benefits) ?? template.benefits;
  const pricing = coercePricing(raw.pricing) ?? template.pricing;
  const faqs = coerceFaqs(raw.faqs) ?? template.faqs;
  const cta = coerceCta(raw.cta) ?? template.cta;

  return {
    version: CONTENT_VERSION,
    hero: {
      eyebrow: template.hero.eyebrow,
      headline,
      headlineAccent: deriveAccent(headline, template.hero.headlineAccent),
      subhead,
      checklist: [...template.hero.checklist],
    },
    benefits,
    painPoints: {
      items: template.painPoints.items.map((c) => ({ ...c })),
      reassurance: template.painPoints.reassurance,
    },
    about: { body: template.about.body, keyFacts: [...template.about.keyFacts] },
    howItWorks: { steps: template.howItWorks.steps.map((c) => ({ ...c })) },
    suitability: {
      heading: template.suitability.heading,
      items: template.suitability.items.map((c) => ({ ...c })),
    },
    pricing,
    faqs,
    cta,
    // Never invented by an upgrade: 3D stays owner-configured only.
    showcase3d: null,
  };
}

/** The full generic v2 content (used only when a treatment has no default). */
export function genericContent(ctaTarget: CtaTarget): LandingPageContent {
  const label = ctaTarget === "assessment" ? "Check your options" : "Book a consultation";
  return {
    version: CONTENT_VERSION,
    hero: {
      eyebrow: GENERIC.eyebrow,
      headline: "Care for your smile, at your pace",
      headlineAccent: "at your pace",
      subhead: "Friendly, careful dentistry with clear guidance and honest pricing from your first visit.",
      checklist: [...GENERIC.checklist],
    },
    benefits: [
      { title: "Clear guidance", detail: "Your options explained properly, with time for your questions." },
      { title: "Honest pricing", detail: "Transparent from prices, confirmed after a clinical assessment." },
      { title: "At your pace", detail: "No pressure to decide on the day; treatment moves when you are ready." },
    ],
    painPoints: {
      items: GENERIC.painPoints.items.map((c) => ({ ...c })),
      reassurance: GENERIC.painPoints.reassurance,
    },
    about: { body: GENERIC.about.body, keyFacts: [...GENERIC.about.keyFacts] },
    howItWorks: { steps: GENERIC.howItWorks.steps.map((c) => ({ ...c })) },
    suitability: {
      heading: GENERIC.suitability.heading,
      items: GENERIC.suitability.items.map((c) => ({ ...c })),
    },
    pricing: {
      lines: [{ treatment: "Check-up", fromPriceGBP: 60 }],
      caveat:
        "Prices shown are a guide and start from the amount listed. Your exact price is confirmed after a clinical assessment.",
    },
    faqs: [
      { q: "What happens first?", a: "A consultation where we listen, examine and explain your options clearly." },
      { q: "How much will it cost?", a: "You will get transparent from prices, confirmed after a clinical assessment." },
      { q: "How do I book?", a: "Use the button on this page and the team will arrange a time that suits you." },
    ],
    cta: { label, target: ctaTarget, targetSlug: null },
    showcase3d: null,
  };
}
