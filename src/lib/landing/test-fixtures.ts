// Shared TEST fixture for the landing-page suites (imported by *.test.ts only;
// never by app code). A minimal, valid, lint-clean schema v2 content object that
// individual tests clone and mutate. Kept out of the *.test.ts files themselves
// so importing it never re-registers another file's suites.

/** A minimal, valid v2 content object to mutate per test. */
export function goodContent(): Record<string, unknown> {
  return {
    hero: {
      eyebrow: "Clear aligner treatment",
      headline: "Straighter teeth, no metal braces, from 3 months",
      headlineAccent: "from 3 months",
      subhead: "A discreet way to straighten your smile, with a free initial consultation.",
      checklist: [
        "Virtually invisible aligners",
        "Removable to eat and brush",
        "0 percent finance available",
        "Free initial consultation",
      ],
    },
    benefits: [
      { title: "Barely there", detail: "Most people will not notice you are wearing them." },
      { title: "Removable", detail: "Take them out to eat, brush and floss." },
      { title: "Spread the cost", detail: "0 percent finance is available." },
    ],
    painPoints: {
      items: [
        { title: "Hiding your smile", body: "You turn away when the camera comes out." },
        { title: "Put off by braces", body: "Metal braces as an adult never appealed." },
        { title: "Not sure where to start", body: "You have wondered about it for a while." },
        { title: "Worried it takes over", body: "You want something that fits around life." },
      ],
      reassurance: "If any of that sounds familiar, you are in good company.",
    },
    about: {
      body: "Invisalign straightens teeth using a series of clear, custom made aligners instead of fixed braces.",
      keyFacts: ["Treatment from around 3 months", "Clear and virtually invisible", "Removable to eat and brush"],
    },
    howItWorks: {
      steps: [
        { title: "Consultation and scan", body: "We talk through your goals and scan your teeth." },
        { title: "Your custom plan", body: "Your dentist maps out a step by step plan." },
        { title: "Wear your aligners", body: "You swap to the next set every couple of weeks." },
        { title: "Result and retention", body: "A retainer helps keep your new smile in place." },
      ],
    },
    suitability: {
      heading: "What Invisalign can help with",
      items: [
        { title: "Crowded teeth", body: "Teeth that overlap or sit too close together." },
        { title: "Gaps and spacing", body: "Noticeable spaces you would like to close." },
        { title: "Crooked front teeth", body: "Front teeth that have shifted over time." },
        { title: "Mild bite concerns", body: "An uneven bite a clinician can assess." },
      ],
    },
    pricing: {
      lines: [{ treatment: "Invisalign", fromPriceGBP: 2500 }],
      caveat: "From price, confirmed after a clinical assessment.",
    },
    faqs: [
      { q: "How long?", a: "It varies from person to person." },
      { q: "Suitable for me?", a: "Depends on a clinical assessment." },
      { q: "Finance?", a: "Yes, 0 percent finance is available." },
    ],
    cta: { label: "Check your options", target: "assessment", targetSlug: null },
  };
}

/** The v1 shape of the seeded demo variant (pre-upgrade), for mapper tests. */
export function v1Content(): Record<string, unknown> {
  return {
    hero: {
      headline: "Straighten your smile with Invisalign",
      subhead:
        "Clear, removable aligners that gently guide your teeth into place, with a free initial consultation.",
    },
    benefits: [
      { title: "Barely there", detail: "Clear aligners that most people will not notice you are wearing day to day." },
      { title: "Removable", detail: "Take them out to eat, brush and floss, so your daily routine stays simple." },
      { title: "A confident smile", detail: "A straighter smile you can feel good about sharing." },
    ],
    pricing: {
      lines: [{ treatment: "Invisalign", fromPriceGBP: 2500 }],
      caveat:
        "Prices shown are a guide and start from the amount listed. Your exact price is confirmed after a clinical assessment.",
    },
    faqs: [
      { q: "How long does treatment take?", a: "It varies from person to person. Your dentist will talk you through a likely timeline at your consultation." },
      { q: "Is Invisalign right for me?", a: "Suitability depends on a clinical assessment. Book a consultation and we will explain your options." },
      { q: "Can I spread the cost?", a: "Yes, 0 percent finance is available. We can go through the options with you at your visit." },
    ],
    cta: { label: "Check your options", target: "assessment", targetSlug: null },
  };
}
