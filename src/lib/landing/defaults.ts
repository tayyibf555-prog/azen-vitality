// Hand-written, GDC/ASA-safe DEFAULT content per treatment.
//
// The generation flow tries the model twice (generate, then one regenerate with
// the lint failures quoted back). If it still cannot produce a clean variant, we
// fall back to one of these tasteful, deterministic defaults rather than store
// anything non-compliant. Every default is written to PASS both validateContent
// and lintContent by construction: prices are the real catalogue prices, the copy
// carries no testimonials, guarantees, pain claims, superlatives or funding words,
// and every "from" price is caveated with the clinical-assessment line.
//
// Keyed by the catalogue treatment key. Covers the six the brief calls for:
// implants, invisalign, whitening, veneers, general check-up, hygiene.
//
// British English, GBP, no em-dashes.

import type { CtaTarget, LandingPageContent } from "./content";

// The single caveat used under every price block. Mirrors the catalogue's
// "a coordinator confirms the exact price per case" language. Deliberately says
// "price" not "plan" (plan reads as a funding/membership scheme).
const CAVEAT =
  "Prices shown are a guide and start from the amount listed. Your exact price is confirmed after a clinical assessment.";

// The raw defaults carry a placeholder CTA; getDefaultContent sets the real target
// and a target-appropriate label.
const DEFAULTS: Record<string, Omit<LandingPageContent, "cta">> = {
  invisalign: {
    hero: {
      headline: "Straighten your smile with Invisalign",
      subhead:
        "Clear, removable aligners that gently guide your teeth into place, with a free initial consultation.",
    },
    benefits: [
      { title: "Barely there", detail: "Clear aligners that most people will not notice you are wearing day to day." },
      { title: "Removable", detail: "Take them out to eat, brush and floss, so your daily routine stays simple." },
      { title: "Spread the cost", detail: "0 percent finance is available to make the investment more manageable." },
    ],
    pricing: { lines: [{ treatment: "Invisalign", fromPriceGBP: 2500 }], caveat: CAVEAT },
    faqs: [
      { q: "How long does treatment take?", a: "It varies from person to person. Your dentist will talk you through a likely timeline at your consultation." },
      { q: "Is Invisalign right for me?", a: "Suitability depends on a clinical assessment. Book a consultation and we will explain your options." },
      { q: "Can I spread the cost?", a: "Yes, 0 percent finance is available. We can go through the options with you at your visit." },
    ],
  },
  implant: {
    hero: {
      headline: "Replace a missing tooth with a dental implant",
      subhead: "A long lasting, natural looking way to fill the gap and eat with confidence again.",
    },
    benefits: [
      { title: "Natural looking", detail: "The crown is matched to your other teeth so it blends in." },
      { title: "Long lasting", detail: "A well cared for implant is a durable way to replace a missing tooth." },
      { title: "Spread the cost", detail: "0 percent finance is available to help with the investment." },
    ],
    pricing: { lines: [{ treatment: "Dental implants", fromPriceGBP: 2400 }], caveat: CAVEAT },
    faqs: [
      { q: "How long does it take?", a: "Treatment usually spans a few visits. Your dentist will explain the steps at your consultation." },
      { q: "Is an implant right for me?", a: "That depends on a clinical assessment. Book a consultation and we will talk through your options." },
      { q: "Can I pay in instalments?", a: "Yes, 0 percent finance is available. We can go through it with you at your visit." },
    ],
  },
  whitening: {
    hero: {
      headline: "Brighten your smile with teeth whitening",
      subhead: "A safe way to lift the shade of your teeth, often noticeable after a single course.",
    },
    benefits: [
      { title: "Noticeable lift", detail: "A brighter smile that can make a real difference to how you feel." },
      { title: "Options to suit you", detail: "Choose a home kit, an in chair treatment, or a combination of both." },
      { title: "Dentist led", detail: "Whitening is carried out under the guidance of a GDC registered dentist." },
    ],
    pricing: { lines: [{ treatment: "Teeth whitening", fromPriceGBP: 350 }], caveat: CAVEAT },
    faqs: [
      { q: "How much brighter will my teeth get?", a: "Results vary from person to person. Your dentist will set out what to expect for you." },
      { q: "Is whitening suitable for me?", a: "Suitability is confirmed by a clinical assessment before any treatment begins." },
      { q: "How long do the results last?", a: "It varies with your habits. We can share simple tips to help keep your smile bright." },
    ],
  },
  veneers: {
    hero: {
      headline: "Refresh your smile with veneers",
      subhead: "Thin covers bonded to the front of your teeth to improve their shape and colour.",
    },
    benefits: [
      { title: "Tailored to you", detail: "Shaped and shaded to suit your face and the look you are after." },
      { title: "A fresh look", detail: "A popular way to refresh the appearance of your smile." },
      { title: "Spread the cost", detail: "0 percent finance is available to make it more manageable." },
    ],
    pricing: { lines: [{ treatment: "Veneers", fromPriceGBP: 450 }], caveat: CAVEAT },
    faqs: [
      { q: "How many visits are needed?", a: "Usually a consultation and a couple of visits. Your dentist will confirm the details." },
      { q: "Are veneers right for me?", a: "That is decided by a clinical assessment, so book a consultation to talk it through." },
      { q: "Can I spread the cost?", a: "Yes, 0 percent finance is available. We can go through the options at your visit." },
    ],
  },
  checkup: {
    hero: {
      headline: "Book your dental check-up",
      subhead: "A routine examination to check your teeth and gums and catch anything early.",
    },
    benefits: [
      { title: "Seen quickly", detail: "Same week appointments are usually available." },
      { title: "Thorough examination", detail: "Your dentist checks your teeth and gums and answers your questions." },
      { title: "Peace of mind", detail: "Regular visits help you stay on top of your oral health." },
    ],
    pricing: { lines: [{ treatment: "Check-up", fromPriceGBP: 60 }], caveat: CAVEAT },
    faqs: [
      { q: "How often should I have a check-up?", a: "Your dentist will suggest how often to return based on your visit." },
      { q: "What happens at a check-up?", a: "A careful look at your teeth and gums, with time to raise any concerns." },
      { q: "Can I book for my family?", a: "Yes, get in touch and we will help arrange appointments that suit you." },
    ],
  },
  hygiene: {
    hero: {
      headline: "Freshen up with a hygiene visit",
      subhead: "A professional clean and polish to remove build up and help keep your gums healthy.",
    },
    benefits: [
      { title: "Fresh feeling", detail: "Leaves your teeth feeling clean and smooth." },
      { title: "Healthier gums", detail: "A scale and polish helps keep gum problems at bay." },
      { title: "Quick and simple", detail: "A straightforward visit that fits around your day." },
    ],
    pricing: { lines: [{ treatment: "Hygiene visit", fromPriceGBP: 75 }], caveat: CAVEAT },
    faqs: [
      { q: "How often should I see the hygienist?", a: "Your hygienist will suggest a routine that suits your needs." },
      { q: "Does it take long?", a: "It is usually a short appointment. We will let you know when you book." },
      { q: "Can I combine it with a check-up?", a: "Yes, we can often arrange both around the same time. Just ask." },
    ],
  },
};

/** The catalogue keys we hold a hand-written default for. */
export const DEFAULT_TREATMENT_KEYS = Object.keys(DEFAULTS);

export function hasDefaultContent(treatmentKey: string): boolean {
  return treatmentKey in DEFAULTS;
}

/**
 * A guaranteed-compliant fallback content set for a treatment, with the CTA
 * pointed at the requested downstream target. Returns null when there is no
 * hand-written default for the key (the caller must have validated the treatment
 * against the catalogue, which shares these keys, so in practice this is present).
 */
export function getDefaultContent(treatmentKey: string, ctaTarget: CtaTarget): LandingPageContent | null {
  const base = DEFAULTS[treatmentKey];
  if (!base) return null;
  const label = ctaTarget === "assessment" ? "Check your options" : "Book a consultation";
  // Deep-ish clone so callers never mutate the shared default.
  return {
    hero: { ...base.hero },
    benefits: base.benefits.map((b) => ({ ...b })),
    pricing: { lines: base.pricing.lines.map((l) => ({ ...l })), caveat: base.pricing.caveat },
    faqs: base.faqs.map((f) => ({ ...f })),
    cta: { label, target: ctaTarget, targetSlug: null },
  };
}
