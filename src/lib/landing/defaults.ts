// Hand-written, GDC/ASA-safe DEFAULT content per treatment (schema v2).
//
// Two jobs:
//   1. The generation flow tries the model twice (generate, then one regenerate
//      with the lint failures quoted back). If it still cannot produce a clean
//      variant, we fall back to one of these tasteful, deterministic defaults
//      rather than store anything non-compliant.
//   2. The v1 -> v2 read-time upgrade mapper (upgrade.ts) fills the NEW v2 sections
//      of an old row from the SAME per-treatment defaults, so the seeded demo keeps
//      rendering as a full conversion page with no DB migration.
//
// Every default is written to PASS both validateContent and lintContent by
// construction: prices are the real catalogue prices, and the copy carries no
// testimonials, guarantees, pain claims, superlatives, funding words, or
// owner-verified proof claims (ratings, awards, press). None ships a showcase3d
// (no default 3D asset).
//
// Keyed by the catalogue treatment key. Covers the six the brief calls for:
// invisalign, implant, whitening, veneers, checkup, hygiene.
//
// British English, GBP, no em-dashes.

import type { CtaTarget, LandingPageContent } from "./content";
import { CONTENT_VERSION } from "./content";

// The single caveat used under every price block. Mirrors the catalogue's
// "a coordinator confirms the exact price per case" language. Deliberately says
// "price" not "plan" (plan reads as a funding/membership scheme).
const CAVEAT =
  "Prices shown are a guide and start from the amount listed. Your exact price is confirmed after a clinical assessment.";

/** The v2 default body for one treatment, minus the CTA/version/showcase (added by getDefaultContent). */
type DefaultBody = Omit<LandingPageContent, "cta" | "version" | "showcase3d">;

const DEFAULTS: Record<string, DefaultBody> = {
  invisalign: {
    hero: {
      eyebrow: "Clear aligner treatment",
      headline: "Straighter teeth, no metal braces, from 3 months",
      headlineAccent: "from 3 months",
      subhead:
        "A discreet way to straighten your smile, with a free initial consultation and a friendly, unrushed team.",
      checklist: [
        "Virtually invisible aligners",
        "Removable to eat and brush",
        "0 percent finance available",
        "Free initial consultation",
      ],
    },
    benefits: [
      { title: "Barely there", detail: "Clear aligners that most people will not notice you are wearing day to day." },
      { title: "Removable", detail: "Take them out to eat, brush and floss, so your daily routine stays simple." },
      { title: "Spread the cost", detail: "0 percent finance is available to make the investment more manageable." },
    ],
    painPoints: {
      items: [
        { title: "Hiding your smile in photos", body: "You catch yourself closing your mouth or turning away when the camera comes out." },
        { title: "Put off by metal braces", body: "The thought of visible train track braces as an adult has kept you from doing anything about it." },
        { title: "Not sure where to start", body: "You have wondered about straightening your teeth for a while, but never quite asked the question." },
        { title: "Worried it takes over", body: "You want a change that fits around work and normal life, not one that gets in the way." },
      ],
      reassurance: "If any of that sounds familiar, you are in good company. Here is how clear aligners can help.",
    },
    about: {
      body:
        "Invisalign straightens teeth using a series of clear, custom made aligners instead of fixed braces. You wear each set for a couple of weeks and they gently move your teeth towards a straighter position over time. Each aligner is made to fit your teeth from a digital scan.",
      keyFacts: [
        "Treatment from around 3 months",
        "Clear and virtually invisible",
        "Removable to eat, brush and floss",
        "0 percent finance available",
        "Free initial consultation",
      ],
    },
    howItWorks: {
      steps: [
        { title: "Consultation and scan", body: "We talk through what you would like to change and take a quick digital scan of your teeth." },
        { title: "Your custom plan", body: "Your dentist maps out a step by step plan and shows you the likely journey for your smile." },
        { title: "Wear your aligners", body: "You wear each set as guided, swapping to the next every couple of weeks." },
        { title: "Result and retention", body: "Once your teeth are where you want them, a retainer helps keep your new smile in place." },
      ],
    },
    suitability: {
      heading: "What Invisalign can help with",
      items: [
        { title: "Crowded teeth", body: "Teeth that overlap or sit too close together and are harder to keep clean." },
        { title: "Gaps and spacing", body: "Noticeable spaces between teeth that you would like to close." },
        { title: "Crooked front teeth", body: "Front teeth that have shifted over time or never sat quite straight." },
        { title: "Mild bite concerns", body: "Some overbite or an uneven bite that a clinician can assess for aligner treatment." },
      ],
    },
    pricing: { lines: [{ treatment: "Invisalign", fromPriceGBP: 2500 }], caveat: CAVEAT },
    faqs: [
      { q: "How long does treatment take?", a: "It varies from person to person. Some cases take a few months, others longer. Your dentist will talk you through a likely timeline at your consultation." },
      { q: "Will people notice I am wearing them?", a: "The aligners are clear and made to fit closely, so most people will not notice them day to day." },
      { q: "Is Invisalign right for me?", a: "Suitability depends on a clinical assessment. Book a consultation and we will explain your options." },
      { q: "Can I spread the cost?", a: "Yes, 0 percent finance is available. We can go through the options with you at your visit." },
      { q: "What happens after treatment?", a: "You will be given a retainer to help hold your teeth in their new position." },
    ],
  },

  implant: {
    hero: {
      eyebrow: "Dental implants",
      headline: "Replace a missing tooth, built to last for years",
      headlineAccent: "last for years",
      subhead:
        "A natural looking way to fill the gap and eat with confidence again, with a careful, unrushed consultation.",
      checklist: [
        "Natural looking result",
        "A durable, long term option",
        "0 percent finance available",
        "Step by step, at your pace",
      ],
    },
    benefits: [
      { title: "Natural looking", detail: "The crown is matched to your other teeth so it blends in." },
      { title: "Long lasting", detail: "A well cared for implant is a durable way to replace a missing tooth." },
      { title: "Spread the cost", detail: "0 percent finance is available to help with the investment." },
    ],
    painPoints: {
      items: [
        { title: "Avoiding certain foods", body: "You find yourself steering clear of foods you used to enjoy because of the gap." },
        { title: "Self conscious when you smile", body: "A missing tooth can make you hold back in photos or when you meet people." },
        { title: "A denture that moves", body: "If you wear a partial denture, you may wish for something that feels more secure." },
        { title: "Unsure about the process", body: "You would like to understand what is involved before you commit to anything." },
      ],
      reassurance: "These are some of the most common reasons people ask us about implants. Here is how they work.",
    },
    about: {
      body:
        "A dental implant is a small fixture that is placed where a tooth is missing and supports a natural looking crown. It gives you a fixed replacement that looks and feels close to your own tooth, so you can smile and eat without the gap getting in the way.",
      keyFacts: [
        "A fixed, natural looking replacement",
        "A durable, long term option",
        "Cared for like a normal tooth",
        "0 percent finance available",
      ],
    },
    howItWorks: {
      steps: [
        { title: "Consultation and assessment", body: "We look at the gap, talk through your goals and check what is possible for you." },
        { title: "Your custom plan", body: "Your dentist sets out the steps, the timeline and the costs, with no pressure to decide on the day." },
        { title: "Placement and healing", body: "The implant is placed and given time to settle, with support from the team throughout." },
        { title: "Your new tooth", body: "A custom crown is fitted on top, matched to your other teeth for a natural finish." },
      ],
    },
    suitability: {
      heading: "What implants can help with",
      items: [
        { title: "A single missing tooth", body: "Fill one gap without involving the healthy teeth on either side." },
        { title: "Several gaps", body: "More than one missing tooth may be replaced, depending on your assessment." },
        { title: "A loose denture", body: "Implants can offer a more secure alternative to a removable denture for some people." },
        { title: "An older gap", body: "A space left for a while can often still be assessed for an implant." },
      ],
    },
    pricing: { lines: [{ treatment: "Dental implants", fromPriceGBP: 2400 }], caveat: CAVEAT },
    faqs: [
      { q: "How long does it take?", a: "Treatment usually spans a few visits with healing time in between. Your dentist will explain the steps at your consultation." },
      { q: "Is an implant right for me?", a: "That depends on a clinical assessment. Book a consultation and we will talk through your options." },
      { q: "Will it look natural?", a: "The crown is shaped and shaded to match your other teeth, so it blends in with your smile." },
      { q: "Can I pay in instalments?", a: "Yes, 0 percent finance is available. We can go through it with you at your visit." },
    ],
  },

  whitening: {
    hero: {
      eyebrow: "Professional teeth whitening",
      headline: "A brighter smile, often in a single visit",
      headlineAccent: "a single visit",
      subhead:
        "A safe, dentist led way to lift the shade of your teeth, with options to suit your routine and your budget.",
      checklist: [
        "Dentist led and safe",
        "Home or in chair options",
        "0 percent finance available",
        "A noticeable lift in shade",
      ],
    },
    benefits: [
      { title: "Noticeable lift", detail: "A brighter smile that can make a real difference to how you feel." },
      { title: "Options to suit you", detail: "Choose a home kit, an in chair treatment, or a combination of both." },
      { title: "Dentist led", detail: "Whitening is carried out under the guidance of a GDC registered dentist." },
    ],
    painPoints: {
      items: [
        { title: "Teeth looking dull", body: "Everyday tea, coffee and time can leave your teeth looking more dull than you would like." },
        { title: "A big event coming up", body: "A wedding, holiday or milestone has you thinking about freshening up your smile." },
        { title: "Wary of home kits", body: "You would rather not risk an unregulated online kit and want something done properly." },
        { title: "Not sure what works", body: "You have seen lots of options and are not sure which is genuinely worth it." },
      ],
      reassurance: "If you would like a brighter smile done safely, here is how dentist led whitening works.",
    },
    about: {
      body:
        "Teeth whitening lifts the shade of your natural teeth using a gel that is applied under the guidance of your dentist. You can whiten at home with custom trays, in the chair, or with a combination of both. Because it is dentist led, your teeth and gums are checked first and the approach is tailored to you.",
      keyFacts: [
        "Dentist led and carried out safely",
        "Home, in chair, or a combination",
        "A noticeable lift in shade",
        "0 percent finance available",
      ],
    },
    howItWorks: {
      steps: [
        { title: "A quick check", body: "Your dentist checks your teeth and gums and talks through what to expect." },
        { title: "Your custom plan", body: "You choose the approach that suits you, and custom trays are made if you whiten at home." },
        { title: "Whitening", body: "You follow the simple routine at home, have the in chair treatment, or combine the two." },
        { title: "Enjoy the result", body: "We share easy tips to help you keep your smile looking bright for longer." },
      ],
    },
    suitability: {
      heading: "Is whitening right for you",
      items: [
        { title: "Stained or dull teeth", body: "Everyday staining from food and drink is one of the most common reasons people whiten." },
        { title: "Healthy teeth and gums", body: "Whitening suits natural teeth in good health, which your dentist confirms first." },
        { title: "A special occasion", body: "Many people whiten ahead of an event they want to feel great for." },
        { title: "A safe, guided option", body: "If you want whitening done under professional care, this is a good fit." },
      ],
    },
    pricing: { lines: [{ treatment: "Teeth whitening", fromPriceGBP: 350 }], caveat: CAVEAT },
    faqs: [
      { q: "How much brighter will my teeth get?", a: "Results vary from person to person. Your dentist will set out what to expect for you before you start." },
      { q: "Is whitening suitable for me?", a: "Suitability is confirmed by a clinical assessment before any treatment begins." },
      { q: "How long do the results last?", a: "It varies with your habits. We can share simple tips to help keep your smile bright." },
      { q: "Can I spread the cost?", a: "Yes, 0 percent finance is available. We can talk it through at your visit." },
    ],
  },

  veneers: {
    hero: {
      eyebrow: "Porcelain and composite veneers",
      headline: "Reshape your smile in as few as two visits",
      headlineAccent: "two visits",
      subhead:
        "Thin covers bonded to the front of your teeth to improve their shape and colour, tailored to suit your face.",
      checklist: [
        "Shaped and shaded to suit you",
        "A fresh, natural looking finish",
        "0 percent finance available",
        "A friendly, unrushed consultation",
      ],
    },
    benefits: [
      { title: "Tailored to you", detail: "Shaped and shaded to suit your face and the look you are after." },
      { title: "A fresh look", detail: "A popular way to refresh the appearance of your smile." },
      { title: "Spread the cost", detail: "0 percent finance is available to make it more manageable." },
    ],
    painPoints: {
      items: [
        { title: "Chips and worn edges", body: "Small chips or worn edges can make you feel your smile looks tired." },
        { title: "Uneven shape or colour", body: "Teeth that are uneven in shape or shade can be hard to feel happy about." },
        { title: "Covering your mouth", body: "You find yourself hiding your teeth in photos or when you laugh." },
        { title: "Wanting a fresh start", body: "You would like a refreshed smile but are not sure which option is right." },
      ],
      reassurance: "If you recognise any of these, veneers may be worth exploring. Here is how they work.",
    },
    about: {
      body:
        "Veneers are thin covers bonded to the front of your teeth to improve their shape, colour and overall look. They can be made from porcelain or built up in composite, and each one is tailored to suit your face and the finish you are after, for a fresh but natural looking smile.",
      keyFacts: [
        "Shaped and shaded to suit you",
        "Porcelain or composite options",
        "A fresh, natural looking finish",
        "0 percent finance available",
      ],
    },
    howItWorks: {
      steps: [
        { title: "Consultation", body: "We talk through the look you want and check that veneers suit your teeth." },
        { title: "Your custom plan", body: "Your dentist designs the shape and shade with you, so you know what to expect." },
        { title: "Fitting your veneers", body: "The veneers are carefully prepared and bonded to your teeth, usually over a couple of visits." },
        { title: "Enjoy your smile", body: "You leave with a refreshed smile, plus simple advice to help it stay looking good." },
      ],
    },
    suitability: {
      heading: "Is a veneer right for you",
      items: [
        { title: "Chipped or worn teeth", body: "Veneers can tidy up small chips and worn edges on front teeth." },
        { title: "Discoloured teeth", body: "They can cover teeth that stay discoloured even after whitening." },
        { title: "Small gaps", body: "Minor gaps between front teeth can often be improved with veneers." },
        { title: "Uneven shape", body: "Teeth that are slightly uneven in shape can be made to look more even." },
      ],
    },
    pricing: { lines: [{ treatment: "Veneers", fromPriceGBP: 450 }], caveat: CAVEAT },
    faqs: [
      { q: "How many visits are needed?", a: "Usually a consultation and a couple of visits. Your dentist will confirm the details for your case." },
      { q: "Are veneers right for me?", a: "That is decided by a clinical assessment, so book a consultation to talk it through." },
      { q: "Will they look natural?", a: "Each veneer is shaped and shaded to suit your face, for a fresh but natural looking finish." },
      { q: "Can I spread the cost?", a: "Yes, 0 percent finance is available. We can go through the options at your visit." },
    ],
  },

  checkup: {
    hero: {
      eyebrow: "Routine dental check-ups",
      headline: "A thorough check-up, often the same week",
      headlineAccent: "the same week",
      subhead:
        "A routine examination to check your teeth and gums and catch anything early, with a friendly, unrushed team.",
      checklist: [
        "Same week appointments usually",
        "A thorough examination",
        "Time to ask questions",
        "Care for all the family",
      ],
    },
    benefits: [
      { title: "Seen quickly", detail: "Same week appointments are usually available." },
      { title: "Thorough examination", detail: "Your dentist checks your teeth and gums and answers your questions." },
      { title: "Peace of mind", detail: "Regular visits help you stay on top of your oral health." },
    ],
    painPoints: {
      items: [
        { title: "Overdue a visit", body: "It has been longer than you meant since your last check-up and you would like to get back on track." },
        { title: "A niggle you have noticed", body: "Something small has caught your attention and you would rather have it looked at early." },
        { title: "New to the area", body: "You have moved and need a friendly practice to look after your teeth." },
        { title: "Booking for the family", body: "You want to sort appointments for everyone without a lot of back and forth." },
      ],
      reassurance: "Whatever the reason, a routine check-up is a simple first step. Here is what to expect.",
    },
    about: {
      body:
        "A dental check-up is a routine examination where your dentist looks at your teeth and gums, talks through anything they notice, and helps you catch small issues before they grow. It is a relaxed appointment with plenty of time to ask questions about your oral health.",
      keyFacts: [
        "A routine examination of teeth and gums",
        "Same week appointments usually available",
        "Time to raise any concerns",
        "Care for the whole family",
      ],
    },
    howItWorks: {
      steps: [
        { title: "Book your visit", body: "Get in touch and we will find an appointment that suits you, often the same week." },
        { title: "Your examination", body: "Your dentist checks your teeth and gums and talks through anything worth noting." },
        { title: "A clear picture", body: "You get a straightforward summary of how things look and any options if needed." },
        { title: "Stay on track", body: "We suggest when to return so you can keep your oral health in good shape." },
      ],
    },
    suitability: {
      heading: "When to book a check-up",
      items: [
        { title: "It has been a while", body: "If you are overdue a visit, a check-up is an easy way to get back on track." },
        { title: "You have noticed something", body: "A niggle, a sensitive spot or a change is worth having looked at early." },
        { title: "You are new to the area", body: "A first check-up is a simple way to register with a practice near you." },
        { title: "Routine care for the family", body: "Regular visits help everyone stay on top of their oral health." },
      ],
    },
    pricing: { lines: [{ treatment: "Check-up", fromPriceGBP: 60 }], caveat: CAVEAT },
    faqs: [
      { q: "How often should I have a check-up?", a: "Your dentist will suggest how often to return based on what they see at your visit." },
      { q: "What happens at a check-up?", a: "A careful look at your teeth and gums, with time to raise any concerns you have." },
      { q: "Can I book for my family?", a: "Yes, get in touch and we will help arrange appointments that suit you." },
    ],
  },

  hygiene: {
    hero: {
      eyebrow: "Professional hygiene care",
      headline: "Fresher, cleaner teeth in one short visit",
      headlineAccent: "one short visit",
      subhead:
        "A professional clean and polish to remove build up and help keep your gums healthy, in a relaxed appointment.",
      checklist: [
        "A thorough scale and polish",
        "Helps keep gums healthy",
        "A short, simple appointment",
        "Advice tailored to you",
      ],
    },
    benefits: [
      { title: "Fresh feeling", detail: "Leaves your teeth feeling clean and smooth." },
      { title: "Healthier gums", detail: "A scale and polish helps keep gum problems at bay." },
      { title: "Quick and simple", detail: "A straightforward visit that fits around your day." },
    ],
    painPoints: {
      items: [
        { title: "Build up you can feel", body: "Your teeth do not feel as smooth or fresh as you would like, even after brushing." },
        { title: "Gums that bleed", body: "You have noticed a little bleeding when you brush and would like to look after your gums." },
        { title: "Staining creeping in", body: "Tea, coffee and time have started to dull your smile between visits." },
        { title: "Due a freshen up", body: "It has been a while since your last clean and you would like that just polished feeling back." },
      ],
      reassurance: "A hygiene visit is a simple way to freshen up and care for your gums. Here is what happens.",
    },
    about: {
      body:
        "A hygiene visit is a professional clean with the hygienist. They remove the build up that brushing alone cannot reach, then polish your teeth so they feel smooth and fresh. It is a key part of keeping your gums healthy, and a good chance to pick up simple tips for your daily routine.",
      keyFacts: [
        "A thorough scale and polish",
        "Helps keep your gums healthy",
        "A short, simple appointment",
        "Personalised care advice",
      ],
    },
    howItWorks: {
      steps: [
        { title: "Book your visit", body: "Get in touch and we will find a time that fits around your day." },
        { title: "A quick check", body: "Your hygienist has a look and talks through how your teeth and gums are doing." },
        { title: "Scale and polish", body: "Build up is gently removed and your teeth are polished until they feel smooth." },
        { title: "Fresh and cared for", body: "You leave with a fresh feeling smile and simple advice to help it last." },
      ],
    },
    suitability: {
      heading: "Who a hygiene visit is for",
      items: [
        { title: "Build up between visits", body: "If your teeth do not feel fresh, a scale and polish can help." },
        { title: "Gums that bleed", body: "Bleeding when you brush is worth caring for early, and the hygienist can help." },
        { title: "Surface staining", body: "A polish can lift some everyday staining from tea, coffee and time." },
        { title: "Keeping on top of things", body: "Regular hygiene visits help keep your teeth and gums in good shape." },
      ],
    },
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

/** Deep clone a default body so callers never mutate the shared object. */
function cloneBody(base: DefaultBody): DefaultBody {
  return {
    hero: { ...base.hero, checklist: [...base.hero.checklist] },
    benefits: base.benefits.map((b) => ({ ...b })),
    painPoints: { items: base.painPoints.items.map((c) => ({ ...c })), reassurance: base.painPoints.reassurance },
    about: { body: base.about.body, keyFacts: [...base.about.keyFacts] },
    howItWorks: { steps: base.howItWorks.steps.map((c) => ({ ...c })) },
    suitability: { heading: base.suitability.heading, items: base.suitability.items.map((c) => ({ ...c })) },
    pricing: { lines: base.pricing.lines.map((l) => ({ ...l })), caveat: base.pricing.caveat },
    faqs: base.faqs.map((f) => ({ ...f })),
  };
}

/**
 * A guaranteed-compliant v2 fallback content set for a treatment, with the CTA
 * pointed at the requested downstream target. Returns null when there is no
 * hand-written default for the key. No showcase3d is set (no default 3D asset).
 */
export function getDefaultContent(treatmentKey: string, ctaTarget: CtaTarget): LandingPageContent | null {
  const base = DEFAULTS[treatmentKey];
  if (!base) return null;
  const label = ctaTarget === "assessment" ? "Check your options" : "Book a consultation";
  return {
    version: CONTENT_VERSION,
    ...cloneBody(base),
    cta: { label, target: ctaTarget, targetSlug: null },
    showcase3d: null,
  };
}
