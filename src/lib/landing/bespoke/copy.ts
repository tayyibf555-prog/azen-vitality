// Static, user-visible COPY for the bespoke Vitality Dental Invisalign landing
// page. Pure data, no I/O, no JSX. Kept in ONE module (separate from the renderer)
// so the compliance test can enumerate every visible string and assert
// scanBannedText finds zero hits, and so the ported design's copy is reviewed in
// one place.
//
// COMPLIANCE (UK GDC/ASA, and this codebase's house style):
//   - NO fabricated testimonials, patient quotes, star ratings or review counts.
//     The bespoke source HTML carried placeholder quotes, star ratings, a trust
//     "4.9 star" stat and a reviews wall; those are all omitted here (the reviews
//     wall and the clinician quote are dropped entirely; the patient-story cards
//     keep only the real photo + the "Invisalign" tag).
//   - No em-dashes or en-dashes (commas / full stops instead), no "$" (GBP only),
//     no NHS/private/"payment plan"/"band" funding words, no superlatives
//     (best / leading / cheapest), no guarantee language.
//   - Pricing uses the real catalogue figure (Invisalign from GBP 2,500) plus the
//     "0% finance available" line. No invented numbers.
// British English throughout.
//
// The per-variant hero + CTA copy is the A/B surface and lives in registry.ts,
// NOT here (this module is the identical-across-variants copy).

export interface TitledPair {
  title: string;
  body: string;
}

export interface HeaderCopy {
  brand: string;
}

export interface SplitHeadCopy {
  eyebrow: string;
  title: string;
  intro: string;
}

export interface CenterHeadCopy {
  eyebrow: string;
  title: string;
  intro?: string;
}

export interface FormCopy {
  eyebrow: string;
  heading: string;
  subheading: string;
  nameLabel: string;
  namePlaceholder: string;
  phoneLabel: string;
  phonePlaceholder: string;
  emailLabel: string;
  emailPlaceholder: string;
  contactHint: string;
  channelLabel: string;
  channelWhatsApp: string;
  channelSms: string;
  channelEmail: string;
  messageLabel: string;
  messagePlaceholder: string;
  consentLabel: string;
  submitFallback: string;
  fineprint: string;
  successTitle: string;
  successBody: string;
  errorGeneric: string;
  errorName: string;
  errorContact: string;
  errorConsent: string;
}

export interface InvisalignLandingCopy {
  header: HeaderCopy;
  /** Shared hero eyebrow (the accented headline + subhead are the A/B surface, in registry.ts). */
  heroEyebrow: string;
  heroPills: string[];
  /** Small factual trust chips (value + label). No ratings, reviews or awards. */
  trust: { value: string; label: string }[];
  form: FormCopy;
  stories: {
    head: SplitHeadCopy;
    /** Photo alt text for the three real patient photos (tag only, no quotes). */
    photoAlts: string[];
    tag: string;
  };
  painPoints: {
    head: CenterHeadCopy;
    items: TitledPair[];
    banner: { lead: string; accent: string; tail: string };
  };
  treatment: {
    head: SplitHeadCopy;
    aboutTitle: string;
    aboutBody: string;
    keyFactsTitle: string;
    keyFacts: string[];
    stepsEyebrow: string;
    steps: TitledPair[];
  };
  aligners: {
    eyebrow: string;
    title: string;
    intro: string;
    /** Alt text for the aligner product image. */
    alt: string;
    features: TitledPair[];
  };
  conditions: {
    head: CenterHeadCopy;
    items: (TitledPair & { key: string; alt: string })[];
  };
  beforeAfter: {
    head: CenterHeadCopy;
    cards: { title: string; caption: string; alt: string }[];
    disclaimer: string;
  };
  why: {
    head: CenterHeadCopy;
    items: TitledPair[];
  };
  pricing: {
    head: CenterHeadCopy;
    priceEyebrow: string;
    priceLabel: string;
    financeChip: string;
    financeNote: string;
    fineprint: string;
    getTitle: string;
    getItems: TitledPair[];
  };
  footer: {
    brand: string;
    tagline: string;
    builtBy: string;
    compliance: string;
  };
}

export const INVISALIGN_LANDING_COPY: InvisalignLandingCopy = {
  header: {
    brand: "VITALITY DENTAL",
  },

  heroEyebrow: "Straighten your smile with clear aligners",

  heroPills: [
    "Virtually invisible",
    "Removable aligners",
    "0% finance available",
    "No brackets or wires",
  ],

  // Replaces the source's fabricated "4.9 star Google rating" trust row with
  // factual, non-proof chips (finance, digital planning, location). These carry no
  // rating, review or award claim, so they need no owner verification.
  trust: [
    { value: "0%", label: "Finance available" },
    { value: "3D", label: "Digital planning" },
  ],

  form: {
    eyebrow: "Free consultation",
    heading: "See if Invisalign is right for you",
    subheading: "Book free. No commitment, and no pressure.",
    nameLabel: "Full name",
    namePlaceholder: "Your full name",
    phoneLabel: "Mobile number",
    phonePlaceholder: "07700 900123",
    emailLabel: "Email address",
    emailPlaceholder: "you@example.com",
    contactHint: "Add a mobile number or an email so the team can reach you.",
    channelLabel: "How should we reach you?",
    channelWhatsApp: "WhatsApp",
    channelSms: "SMS",
    channelEmail: "Email",
    messageLabel: "Your message (optional)",
    messagePlaceholder: "Anything you would like us to know",
    consentLabel: "I agree to be contacted about my enquiry.",
    submitFallback: "Book my free consultation",
    fineprint: "Your details are only used to arrange your consultation.",
    successTitle: "Thanks, your enquiry is in.",
    successBody: "The team will be in touch shortly to arrange your free consultation.",
    errorGeneric: "Something went wrong. Please try again, or call the practice.",
    errorName: "Please enter your name.",
    errorContact: "Please add a mobile number or an email address.",
    errorConsent: "Please tick the box so we can contact you about your enquiry.",
  },

  stories: {
    head: {
      eyebrow: "Patient stories",
      title: "Real patients, real results",
      intro: "Every smile is different, and every result is planned around the person it belongs to.",
    },
    photoAlts: [
      "Vitality Dental Invisalign patient seeing her new smile in the mirror",
      "Vitality Dental Invisalign patient smiling at his result in the mirror",
      "Vitality Dental Invisalign patient laughing at her new smile in the mirror",
    ],
    tag: "Invisalign",
  },

  painPoints: {
    head: {
      eyebrow: "Sound familiar?",
      title: "You have wanted straight teeth for years",
      intro:
        "Most people who come to us for Invisalign have thought about it for a long time. They just never found an option that fit their life.",
    },
    items: [
      {
        title: "Crowded or overlapping teeth",
        body: "You have always been aware of it. Smiling with your mouth fully open has never felt quite natural.",
      },
      {
        title: "Gaps in your front teeth",
        body: "Noticeable in every photo. Whitening helped the colour, but the gap is still there every time you smile.",
      },
      {
        title: "An overbite or underbite",
        body: "Your bite feels slightly off. It affects how your smile looks from the front and from the side.",
      },
      {
        title: "Self-conscious in photos",
        body: "You have a camera face. You know your angles. You have been doing it for years without realising why.",
      },
      {
        title: "Metal braces feel like a step back",
        body: "You would love straight teeth, but fixed braces never sat right for your lifestyle, your career, or your age.",
      },
      {
        title: "You have been putting it off",
        body: "It has been on your list for years. You are still waiting for the right time. There is not one, there is just doing it.",
      },
    ],
    banner: {
      lead: "Invisalign straightens your teeth with ",
      accent: "clear, removable aligners",
      tail: ". No brackets, no wires, and no one needs to know.",
    },
  },

  treatment: {
    head: {
      eyebrow: "The treatment",
      title: "Clear aligners. Custom-fitted. Changed every two weeks.",
      intro:
        "Invisalign uses a series of precisely engineered clear aligners to shift your teeth gradually, with no fixed brackets, no monthly tightening, and no one knowing you are in treatment.",
    },
    aboutTitle: "What is Invisalign?",
    aboutBody:
      "Invisalign is a system of custom-made, removable clear aligners that move your teeth a little at a time. Each set is made from smooth, virtually invisible plastic and designed to apply gentle, precise pressure at every stage. You wear each set for one to two weeks, then move to the next. No brackets, no wires, no dietary restrictions, so you take them out to eat, drink, brush and floss as normal. Your full plan is mapped in 3D before you begin, so you see your projected result from day one.",
    keyFactsTitle: "Key facts",
    keyFacts: [
      "From 3 months",
      "Virtually invisible",
      "Fully removable",
      "No dietary restrictions",
      "0% finance available",
    ],
    stepsEyebrow: "How it works",
    steps: [
      {
        title: "Free consultation",
        body: "We assess your teeth, discuss your goals, and take a 3D scan. You see a projected outcome before committing to anything.",
      },
      {
        title: "Custom aligner plan",
        body: "Your full treatment plan is mapped digitally and your bespoke aligners are made, a full series from start to finish.",
      },
      {
        title: "Wear your aligners",
        body: "20 to 22 hours a day, changing to a new set every one to two weeks, with regular check-ins with your clinician.",
      },
      {
        title: "Reveal your smile",
        body: "Treatment complete. You receive retainers to hold your result, a straight smile that lasts, as long as you wear them.",
      },
    ],
  },

  aligners: {
    eyebrow: "Meet your aligners",
    title: "Clear aligners, made just for you",
    intro: "A full series of custom aligners, worn in order, each one moving your teeth a little closer to the finish.",
    alt: "A clear Invisalign aligner lifting out of its case",
    features: [
      {
        title: "Clear and discreet",
        body: "Thin, transparent aligners that most people will not notice you are wearing day to day.",
      },
      {
        title: "Removable",
        body: "Take them out to eat, drink, brush and floss, then simply pop them back in.",
      },
      {
        title: "Custom made",
        body: "Each set is made from a 3D scan of your teeth, for a precise and comfortable fit.",
      },
    ],
  },

  conditions: {
    head: {
      eyebrow: "Conditions treated",
      title: "What can Invisalign fix?",
    },
    items: [
      {
        key: "crowded",
        title: "Crowded teeth",
        alt: "Crowded teeth 3D model",
        body: "When there is not enough room for all your teeth to sit properly, they overlap and twist. This makes cleaning harder and raises the risk of decay. Invisalign gently guides them into line.",
      },
      {
        key: "gaps",
        title: "Gaps between teeth",
        alt: "Gaps between teeth 3D model",
        body: "Spacing between teeth can trap food and affect how even your smile looks. Invisalign closes these gaps for a more uniform, healthier smile.",
      },
      {
        key: "open-bite",
        title: "Open bite",
        alt: "Open bite 3D model",
        body: "An open bite is when the upper and lower front teeth do not meet when the back teeth are closed. It can make biting difficult. Invisalign helps bring them together.",
      },
      {
        key: "underbite",
        title: "Underbite",
        alt: "Underbite 3D model",
        body: "An underbite is when the lower front teeth sit ahead of the upper ones. It can affect chewing, speech and wear. Invisalign can gradually rebalance the bite.",
      },
      {
        key: "overbite",
        title: "Overbite",
        alt: "Overbite 3D model",
        body: "A deep overbite is when the upper front teeth overlap the lower ones too far. Left alone it can cause wear and jaw discomfort. Invisalign helps reduce it.",
      },
      {
        key: "crossbite",
        title: "Crossbite",
        alt: "Crossbite 3D model",
        body: "A crossbite is when some upper teeth sit inside the lower teeth instead of outside. Over time it can cause wear and gum problems. Invisalign moves them into the correct position.",
      },
    ],
  },

  beforeAfter: {
    head: {
      eyebrow: "Results",
      title: "Before and after",
      intro: "Every case is planned individually, and the result is mapped digitally before treatment even begins.",
    },
    cards: [
      {
        title: "Before and after",
        caption: "Genuine patient result",
        alt: "Before and after: a straighter, brighter smile at Vitality Dental",
      },
      {
        title: "Before and after",
        caption: "Genuine patient result",
        alt: "Before and after close-up of the upper front teeth at Vitality Dental",
      },
      {
        title: "Invisalign, then composite bonding",
        caption: "Genuine patient result",
        alt: "Before Invisalign, after Invisalign, and after composite bonding at Vitality Dental",
      },
    ],
    disclaimer:
      "Individual results vary. Before and after images are of genuine Vitality Dental patients, shown with their written consent.",
  },

  why: {
    head: {
      eyebrow: "Why Vitality Dental",
      title: "Straightening, done properly",
    },
    items: [
      {
        title: "Clinically planned",
        body: "Every case is assessed and planned by a GDC registered dentist before your treatment begins.",
      },
      {
        title: "Clinician-led care",
        body: "You are treated by an experienced clinician who plans and monitors your result personally, start to finish.",
      },
      {
        title: "Easy to get to",
        body: "Convenient and welcoming, with flexible appointment times around your schedule.",
      },
      {
        title: "3D planned from day one",
        body: "A digital scan shows your projected outcome before you commit, so you know what to expect.",
      },
      {
        title: "0% interest-free finance",
        body: "Spread the cost with no added interest. Start today without paying everything upfront.",
      },
      {
        title: "Tracked scan to finish",
        body: "Regular check-ins, adjustments where needed, and support at every stage of your treatment.",
      },
    ],
  },

  pricing: {
    head: {
      eyebrow: "Pricing",
      title: "Transparent pricing. No surprises.",
      intro:
        "Worried about the cost of straightening your teeth? We offer clear, flexible pricing and finance to make Invisalign more accessible. Your exact price is confirmed at your free consultation.",
    },
    priceEyebrow: "Invisalign treatment starts from",
    priceLabel: "£2,500",
    financeChip: "0% finance available",
    financeNote:
      "Spread the cost with no added interest. Your exact price is confirmed after a clinical assessment, and is always the real catalogue price, never an invented figure.",
    fineprint: "Your details are only used to arrange your consultation.",
    getTitle: "What you get",
    getItems: [
      { title: "Retainers included", body: "Protect your result from day one." },
      {
        title: "Free initial consultation",
        body: "No cost, no commitment. Find out if Invisalign is right for you.",
      },
      {
        title: "0% interest-free finance",
        body: "Start today without paying everything upfront.",
      },
      { title: "3D digital planning", body: "See your projected outcome before you begin." },
    ],
  },

  footer: {
    brand: "Vitality Dental",
    tagline: "Invisalign",
    builtBy: "Built by Azen",
    compliance:
      "Our dentists are GDC registered. Treatment suitability always depends on a clinical assessment.",
  },
};

// ---------------------------------------------------------------------------
// COMPOSITE BONDING
// ---------------------------------------------------------------------------
// Static, user-visible COPY for the bespoke Vitality Dental composite bonding
// landing page. Adapts the Invisalign layout to bonding, kept in the same module
// so the SAME compliance test enumerates every visible string and asserts
// scanBannedText finds zero hits.
//
// COMPLIANCE (UK GDC/ASA + house style), same rules as the Invisalign copy:
//   - NO testimonials, patient quotes, star ratings or review counts (Vitality has
//     no owner-verified rating). The patient-story + before/after sections are
//     LABELLED PLACEHOLDERS, because there are no real bonding photos yet.
//   - No em/en-dashes, no "$" (GBP only), no NHS/private/"payment plan"/"band"
//     funding words, no superlatives (best / leading / cheapest), no guarantees.
//   - Clinical claims kept modest and honest: bonding is "usually one visit" with
//     "minimal preparation"; it "can chip or stain over time". NO "no drilling ever",
//     "permanent" or "painless" claims.
//   - Pricing uses the real catalogue figure (Composite bonding from GBP 180) plus
//     the "0% finance available" line. No invented numbers.
// British English throughout. Per-variant hero + CTA copy is the A/B surface and
// lives in registry.ts, NOT here.

export interface BondingLandingCopy {
  header: HeaderCopy;
  /** Shared hero eyebrow (the accented headline + subhead are the A/B surface, in registry.ts). */
  heroEyebrow: string;
  heroPills: string[];
  /** Small factual trust chips (value + label). No ratings, reviews or awards. */
  trust: { value: string; label: string }[];
  form: FormCopy;
  /** "What composite bonding fixes": six line-icon cards (paired with icons by index). */
  fixes: {
    head: CenterHeadCopy;
    items: TitledPair[];
    banner: { lead: string; accent: string; tail: string };
  };
  treatment: {
    head: SplitHeadCopy;
    aboutTitle: string;
    aboutBody: string;
    keyFactsTitle: string;
    keyFacts: string[];
    stepsEyebrow: string;
    /** Four steps: consult, shade match, shaping, polish. */
    steps: TitledPair[];
  };
  /** Three benefit cards (paired with icons by index). */
  benefits: {
    head: CenterHeadCopy;
    items: TitledPair[];
  };
  suitability: {
    head: CenterHeadCopy;
    items: TitledPair[];
  };
  /** Placeholder patient-story slots (no real photos yet). */
  stories: {
    head: SplitHeadCopy;
    placeholderTitle: string;
    placeholderNote: string;
  };
  /** Placeholder before/after slots (no real photos yet) + kept consent disclaimer. */
  beforeAfter: {
    head: CenterHeadCopy;
    placeholderTitle: string;
    placeholderNote: string;
    capTitle: string;
    capNote: string;
    disclaimer: string;
  };
  why: {
    head: CenterHeadCopy;
    items: TitledPair[];
  };
  pricing: {
    head: CenterHeadCopy;
    priceEyebrow: string;
    priceLabel: string;
    financeChip: string;
    financeNote: string;
    fineprint: string;
    getTitle: string;
    getItems: TitledPair[];
  };
  footer: {
    brand: string;
    tagline: string;
    builtBy: string;
    compliance: string;
  };
}

export const BONDING_LANDING_COPY: BondingLandingCopy = {
  header: {
    brand: "VITALITY DENTAL",
  },

  heroEyebrow: "Repair chips, gaps and worn edges",

  heroPills: [
    "Tooth coloured",
    "0% finance available",
    "Minimal preparation",
  ],

  // Factual, non-proof chips (finance, the real from-price, location). No rating,
  // review or award claim, so they need no owner verification.
  trust: [
    { value: "0%", label: "Finance available" },
    { value: "£180", label: "Treatment from" },
  ],

  form: {
    eyebrow: "Free consultation",
    heading: "See if composite bonding is right for you",
    subheading: "Book free. No commitment, and no pressure.",
    nameLabel: "Full name",
    namePlaceholder: "Your full name",
    phoneLabel: "Mobile number",
    phonePlaceholder: "07700 900123",
    emailLabel: "Email address",
    emailPlaceholder: "you@example.com",
    contactHint: "Add a mobile number or an email so the team can reach you.",
    channelLabel: "How should we reach you?",
    channelWhatsApp: "WhatsApp",
    channelSms: "SMS",
    channelEmail: "Email",
    messageLabel: "Your message (optional)",
    messagePlaceholder: "Anything you would like us to know",
    consentLabel: "I agree to be contacted about my enquiry.",
    submitFallback: "Book my free consultation",
    fineprint: "Your details are only used to arrange your consultation.",
    successTitle: "Thanks, your enquiry is in.",
    successBody: "The team will be in touch shortly to arrange your free consultation.",
    errorGeneric: "Something went wrong. Please try again, or call the practice.",
    errorName: "Please enter your name.",
    errorContact: "Please add a mobile number or an email address.",
    errorConsent: "Please tick the box so we can contact you about your enquiry.",
  },

  fixes: {
    head: {
      eyebrow: "What it fixes",
      title: "What composite bonding can tidy up",
    },
    items: [
      {
        title: "Chipped teeth",
        body: "A small chip on a front tooth can be built back up with tooth coloured material and shaped to match.",
      },
      {
        title: "Gaps and spacing",
        body: "Minor gaps between the front teeth can be closed or narrowed, for a more even looking smile.",
      },
      {
        title: "Uneven or worn edges",
        body: "Edges that have worn down or sit unevenly can be reshaped so the smile looks more balanced.",
      },
      {
        title: "Small or peg shaped teeth",
        body: "A tooth that looks small next to its neighbours can be gently built up to a more even size.",
      },
      {
        title: "Minor discolouration on a tooth",
        body: "A single mark or patch of discolouration on a tooth can often be masked with bonding material.",
      },
      {
        title: "Rounded or squared edges",
        body: "The shape of an edge can be softened or squared to suit the look you are after, all by hand.",
      },
    ],
    banner: {
      lead: "Composite bonding shapes tooth coloured material onto your teeth, ",
      accent: "usually in a single visit",
      tail: ", with minimal preparation of the tooth.",
    },
  },

  treatment: {
    head: {
      eyebrow: "The treatment",
      title: "Composite bonding, shaped by hand in one appointment",
      intro:
        "Composite bonding uses a tooth coloured resin that your dentist shapes directly onto the tooth, then sets firm and polishes, so small chips, gaps and uneven edges can be tidied up with minimal preparation.",
    },
    aboutTitle: "What is composite bonding?",
    aboutBody:
      "Composite bonding is a tooth coloured resin that is applied to the tooth, shaped by hand, then set firm and polished so it blends with your natural teeth. It is used to repair small chips, close minor gaps, and reshape uneven or worn edges. It usually needs little preparation of the tooth underneath, and in many cases it can be done in a single visit. Over time bonding can chip or stain and may need a small repair or refresh, which your dentist will talk through with you.",
    keyFactsTitle: "Key facts",
    keyFacts: [
        "Tooth coloured resin",
      "Minimal preparation",
      "0% finance available",
      "Free initial consultation",
    ],
    stepsEyebrow: "How it works",
    steps: [
      {
        title: "Free consultation",
        body: "We look at the teeth you would like to change, talk through what bonding can and cannot do, and check it suits you.",
      },
      {
        title: "Shade match",
        body: "Your dentist matches the resin to the colour of your natural teeth, so the finished result blends in.",
      },
      {
        title: "Shaping",
        body: "The tooth coloured material is applied and shaped directly onto the tooth, then set firm, building up the area a little at a time.",
      },
      {
        title: "Polish and finish",
        body: "The bonding is smoothed and polished so it feels comfortable and blends with the teeth around it.",
      },
    ],
  },

  benefits: {
    head: {
      eyebrow: "Why consider it",
      title: "A simple way to refine your smile",
    },
    items: [
      {
        title: "Kept simple",
        body: "Small chips, gaps and uneven edges tidied up with minimal preparation of the tooth.",
      },
      {
        title: "Often one visit",
        body: "Many bonding cases are completed in a single appointment, so there is little disruption to your day.",
      },
      {
        title: "Spread the cost",
        body: "0% finance is available, so you can spread the cost of your treatment.",
      },
    ],
  },

  suitability: {
    head: {
      eyebrow: "Is it right for you",
      title: "When composite bonding is a good fit",
    },
    items: [
      {
        title: "Small cosmetic changes",
        body: "Bonding suits small, cosmetic changes to the shape, edges or colour of a tooth.",
      },
      {
        title: "One or a few teeth",
        body: "It works well when you want to tidy up one tooth or a small number of teeth at the front.",
      },
      {
        title: "Healthy teeth and gums",
        body: "Bonding is added to healthy teeth, so any decay or gum concerns are treated first.",
      },
      {
        title: "Assessed case by case",
        body: "A dentist checks whether bonding, or another option, is the right fit for what you would like to change.",
      },
    ],
  },

  stories: {
    head: {
      eyebrow: "Patient stories",
      title: "Real patients, real results",
      intro:
        "We are adding consented photos of real Vitality Dental bonding cases. In the meantime, your dentist can show you examples at your consultation.",
    },
    placeholderTitle: "Your consented bonding case here",
    placeholderNote: "Real patient photos will appear here once added, with written consent.",
  },

  beforeAfter: {
    head: {
      eyebrow: "Results",
      title: "Before and after",
      intro:
        "Every case is different, and your dentist will talk through what composite bonding can realistically achieve for your teeth.",
    },
    placeholderTitle: "Your consented bonding case here",
    placeholderNote: "Before and after photos will be added once the practice has consented cases to show.",
    capTitle: "Before and after",
    capNote: "Photo coming soon",
    disclaimer:
      "Individual results vary. Before and after images will be of genuine Vitality Dental patients, shown with their written consent.",
  },

  why: {
    head: {
      eyebrow: "Why Vitality Dental",
      title: "Cosmetic dentistry, done properly",
    },
    items: [
      {
        title: "Clinically assessed",
        body: "Every case is assessed by a GDC registered dentist before any treatment begins.",
      },
      {
        title: "Clinician-led care",
        body: "You are treated by an experienced clinician who plans and carries out your bonding personally.",
      },
      {
        title: "Shade matched by hand",
        body: "The resin is matched and shaped to your natural teeth, so the result blends in.",
      },
      {
        title: "Easy to get to",
        body: "Convenient and welcoming, with flexible appointment times around your schedule.",
      },
      {
        title: "0% interest-free finance",
        body: "Spread the cost with no added interest. Start today without paying everything upfront.",
      },
      {
        title: "Honest, unrushed advice",
        body: "We talk through what bonding can and cannot do, so you can decide what is right for you.",
      },
    ],
  },

  pricing: {
    head: {
      eyebrow: "Pricing",
      title: "Clear pricing, no surprises.",
      intro:
        "The cost of composite bonding depends on how many teeth are treated and how much shaping is involved. Your exact price is confirmed at your free consultation.",
    },
    priceEyebrow: "Composite bonding starts from",
    priceLabel: "£180",
    financeChip: "0% finance available",
    financeNote:
      "Spread the cost with no added interest. Your exact price is confirmed after a clinical assessment, and is always the real catalogue price, never an invented figure.",
    fineprint: "Your details are only used to arrange your consultation.",
    getTitle: "What you get",
    getItems: [
      { title: "Shade matched by hand", body: "Material matched to the colour of your natural teeth." },
      {
        title: "Free initial consultation",
        body: "No cost, no commitment. See if bonding is right for you.",
      },
      {
        title: "0% interest-free finance",
        body: "Start today without paying everything upfront.",
      },
    ],
  },

  footer: {
    brand: "Vitality Dental",
    tagline: "Composite bonding",
    builtBy: "Built by Azen",
    compliance:
      "Our dentists are GDC registered. Treatment suitability always depends on a clinical assessment.",
  },
};

// ---------------------------------------------------------------------------
// HYGIENE (scale and polish)
// ---------------------------------------------------------------------------
// Static, user-visible COPY for the bespoke Vitality Dental hygiene landing page.
// Adapts the Invisalign/bonding layout to a routine hygiene visit, kept in the same
// module so the SAME compliance test enumerates every visible string (including the
// before/after slider caption + labels) and asserts scanBannedText finds zero hits.
//
// COMPLIANCE (UK GDC/ASA + house style), same rules as the other bespoke copy:
//   - NO testimonials, patient quotes, star ratings or review counts.
//   - No em/en-dashes, no "$" (GBP only), no NHS/private/"payment plan"/"band"
//     funding words, no superlatives (best / leading / cheapest), no guarantees,
//     no pain-free claims. Clinical claims kept modest and honest (a clean "helps
//     keep your gums healthy"; the hygienist "works gently"), never "painless".
//   - Hygiene has NO finance (catalog financeAvailable is false), so there is NO
//     "0% finance" / "spread the cost" / interest wording ANYWHERE in this corpus,
//     unlike the Invisalign and bonding pages.
//   - The before/after SLIDER shows a stylised ILLUSTRATION, never a real patient
//     photo, so its caption says so verbatim ("Illustrative model, not a patient
//     photo.").
//   - Pricing uses the real catalogue figure (Hygiene visit from GBP 75). No
//     invented numbers.
// British English throughout. Per-variant hero + CTA copy is the A/B surface and
// lives in registry.ts, NOT here.

export interface HygieneLandingCopy {
  header: HeaderCopy;
  /** Shared hero eyebrow (the accented headline + subhead are the A/B surface, in registry.ts). */
  heroEyebrow: string;
  heroPills: string[];
  /** Small factual trust chips (value + label). No ratings, reviews or awards. */
  trust: { value: string; label: string }[];
  form: FormCopy;
  /** Section 3: "sound familiar" concerns, six line-icon cards (paired with icons by index) + banner. */
  concerns: {
    head: CenterHeadCopy;
    items: TitledPair[];
    banner: { lead: string; accent: string; tail: string };
  };
  treatment: {
    head: SplitHeadCopy;
    aboutTitle: string;
    aboutBody: string;
    keyFactsTitle: string;
    keyFacts: string[];
    stepsEyebrow: string;
    /** Four steps: quick check, gentle scaling, polish, tips for home. */
    steps: TitledPair[];
  };
  /** Section 5: "what a professional clean helps with", six line-icon cards (paired with icons by index). */
  helps: {
    head: CenterHeadCopy;
    items: TitledPair[];
  };
  /** Section 6: product band (align-band), image + three numbered callouts. */
  product: {
    eyebrow: string;
    title: string;
    intro: string;
    /** Alt text for the product-band image. */
    alt: string;
    features: TitledPair[];
  };
  /** Section 7: before/after slider (dark results band). The image is an ILLUSTRATION. */
  beforeAfter: {
    head: CenterHeadCopy;
    beforeLabel: string;
    afterLabel: string;
    beforeAlt: string;
    afterAlt: string;
    /** Verbatim caption; the slider is an illustration, never a real patient photo. */
    caption: string;
  };
  why: {
    head: CenterHeadCopy;
    items: TitledPair[];
  };
  /** Pricing: NO finance (hygiene financeAvailable is false), so no 0%/interest wording. */
  pricing: {
    head: CenterHeadCopy;
    priceEyebrow: string;
    priceLabel: string;
    /** Honest caveat (real catalogue price), the finance-free equivalent of the other pages' note. */
    priceNote: string;
    fineprint: string;
    getTitle: string;
    getItems: TitledPair[];
  };
  /** Section 9: a short hygiene FAQ (native disclosure list). */
  faq: {
    head: CenterHeadCopy;
    items: { q: string; a: string }[];
  };
  footer: {
    brand: string;
    tagline: string;
    builtBy: string;
    compliance: string;
  };
}

export const HYGIENE_LANDING_COPY: HygieneLandingCopy = {
  header: {
    brand: "VITALITY DENTAL",
  },

  heroEyebrow: "Professional scale and polish",

  heroPills: [
    "Scale and polish",
    "Seen by a hygienist",
    "Removes plaque and staining",
    "Fresher, cleaner feel",
  ],

  // Factual, non-proof chips (the real from-price, the three sites, a typical
  // length). No rating, review or award claim, so they need no owner verification.
  trust: [
    { value: "£75", label: "Hygiene visit from" },
    { value: "30 min", label: "Usually per visit" },
  ],

  form: {
    eyebrow: "Book a hygiene visit",
    heading: "Book your hygiene visit",
    subheading: "Book your visit. No pressure, and no obligation.",
    nameLabel: "Full name",
    namePlaceholder: "Your full name",
    phoneLabel: "Mobile number",
    phonePlaceholder: "07700 900123",
    emailLabel: "Email address",
    emailPlaceholder: "you@example.com",
    contactHint: "Add a mobile number or an email so the team can reach you.",
    channelLabel: "How should we reach you?",
    channelWhatsApp: "WhatsApp",
    channelSms: "SMS",
    channelEmail: "Email",
    messageLabel: "Your message (optional)",
    messagePlaceholder: "Tell us about any staining, or when your last clean was",
    consentLabel: "I agree to be contacted about my enquiry.",
    submitFallback: "Book my hygiene visit",
    fineprint: "Your details are only used to arrange your visit.",
    successTitle: "Thanks, your enquiry is in.",
    successBody: "The team will be in touch shortly to arrange your hygiene visit.",
    errorGeneric: "Something went wrong. Please try again, or call the practice.",
    errorName: "Please enter your name.",
    errorContact: "Please add a mobile number or an email address.",
    errorConsent: "Please tick the box so we can contact you about your enquiry.",
  },

  concerns: {
    head: {
      eyebrow: "Sound familiar?",
      title: "The little things you have noticed",
      intro:
        "Most people who book a hygiene visit have put up with the same small niggles for a while. A professional clean sorts them out.",
    },
    items: [
      {
        title: "A rough, furry feeling",
        body: "That fuzzy film on your teeth by the end of the day, however well you brush.",
      },
      {
        title: "Tea and coffee staining",
        body: "Everyday cups leave a dullness and staining that brushing at home does not shift.",
      },
      {
        title: "Tender or bleeding gums",
        body: "Gums that feel sore or bleed a little when you brush can be a sign of build up.",
      },
      {
        title: "Conscious of freshness",
        body: "You would like your mouth to feel cleaner and fresher, for longer.",
      },
      {
        title: "It has been a while",
        body: "Life got busy and your last clean was longer ago than you would like to admit.",
      },
      {
        title: "Wanting a fresh start",
        body: "You want to reset, get on top of it, and keep your teeth feeling clean and fresh.",
      },
    ],
    banner: {
      lead: "A professional clean removes the build up that brushing leaves behind, ",
      accent: "for a fresher, cleaner feel",
      tail: ", and helps keep your gums healthy.",
    },
  },

  treatment: {
    head: {
      eyebrow: "The visit",
      title: "A professional scale and polish, with a hygienist",
      intro:
        "A hygiene visit is a thorough clean that removes the plaque and tartar brushing cannot, lifts everyday staining, and leaves your teeth feeling smooth and fresh.",
    },
    aboutTitle: "What is a hygiene visit?",
    aboutBody:
      "A hygiene visit, sometimes called a scale and polish, is a professional clean carried out by a dental hygienist. They gently remove the hardened plaque and tartar that build up over time, including along the gumline where a toothbrush struggles to reach. Your teeth are then polished to lift surface staining and leave them feeling smooth. To finish, the hygienist shows you simple ways to look after your teeth and gums at home, so the fresh feeling lasts. Regular visits help keep your gums healthy and make each clean easier than the last.",
    keyFactsTitle: "Key facts",
    keyFacts: [
      "Around 30 minutes",
      "With a dental hygienist",
      "Scale and polish",
      "Lifts surface staining",
      "Home care advice",
    ],
    stepsEyebrow: "How it works",
    steps: [
      {
        title: "Quick check",
        body: "The hygienist looks over your teeth and gums and asks about anything you have noticed.",
      },
      {
        title: "Gentle scaling",
        body: "Hardened plaque and tartar are carefully removed from your teeth and along the gumline.",
      },
      {
        title: "Polish",
        body: "Your teeth are polished to lift surface staining and left feeling smooth and clean.",
      },
      {
        title: "Tips for home",
        body: "You get simple, practical advice on brushing and cleaning between your teeth.",
      },
    ],
  },

  helps: {
    head: {
      eyebrow: "What it helps with",
      title: "What a professional clean helps with",
    },
    items: [
      {
        title: "Plaque and tartar",
        body: "A scale removes the hardened build up that brushing alone leaves behind.",
      },
      {
        title: "Surface staining",
        body: "A polish lifts everyday staining from tea, coffee and food, for a brighter look.",
      },
      {
        title: "Gum health",
        body: "Removing build up along the gumline helps keep your gums healthy and comfortable.",
      },
      {
        title: "A fresher feel",
        body: "Teeth feel smooth and clean, and your mouth feels fresher afterwards.",
      },
      {
        title: "Regular upkeep",
        body: "Coming in regularly makes each clean easier and keeps small problems small.",
      },
      {
        title: "Home care advice",
        body: "Simple, practical tips so you can keep things fresh between visits.",
      },
    ],
  },

  product: {
    eyebrow: "The result",
    title: "A clean you can feel",
    intro:
      "The moment you run your tongue over your teeth afterwards, you can feel the difference. Smooth, fresh and properly clean.",
    alt: "A fresh, clean and healthy looking smile after a professional hygiene visit at Vitality Dental",
    features: [
      {
        title: "Deep clean",
        body: "Plaque and tartar lifted from places a toothbrush cannot reach, including along the gumline.",
      },
      {
        title: "Stain removal",
        body: "A polish that lifts surface staining from tea, coffee and everyday food and drink.",
      },
      {
        title: "Healthier gums",
        body: "Clearing away build up helps keep your gums healthy and feeling comfortable.",
      },
    ],
  },

  beforeAfter: {
    head: {
      eyebrow: "See the difference",
      title: "What a professional clean can do",
      intro:
        "An illustrative look at how a scale and polish lifts everyday staining and leaves teeth looking brighter and cleaner.",
    },
    beforeLabel: "Before",
    afterLabel: "After",
    beforeAlt: "Illustration of a dull, stained smile before a professional clean",
    afterAlt: "Illustration of a brighter, cleaner smile after a professional clean",
    caption: "Drag to compare. Illustrative model, not a patient photo.",
  },

  why: {
    head: {
      eyebrow: "Why Vitality Dental",
      title: "Hygiene care, done properly",
    },
    items: [
      {
        title: "Clinically led",
        body: "Your hygiene care is overseen by a GDC registered dentist.",
      },
      {
        title: "Seen by a hygienist",
        body: "A trained hygienist carries out your scale and polish and shows you how to care for your teeth at home.",
      },
      {
        title: "Gentle and unrushed",
        body: "We take our time, especially if your gums are tender or it has been a while since your last visit.",
      },
      {
        title: "Three London sites",
        body: "Book a time that suits you, with flexible appointments around your schedule.",
      },
      {
        title: "Clear pricing",
        body: "A hygiene visit from £75, confirmed with you before anything goes ahead.",
      },
      {
        title: "Advice you can use",
        body: "Practical, honest tips for keeping your teeth and gums healthy between visits.",
      },
    ],
  },

  pricing: {
    head: {
      eyebrow: "Pricing",
      title: "Clear pricing, no surprises.",
      intro:
        "A professional hygiene visit is £75. Your exact price is always confirmed with you before your appointment goes ahead.",
    },
    priceEyebrow: "Hygiene visit from",
    priceLabel: "£75",
    priceNote:
      "Your price is confirmed before treatment, and is always the real catalogue price, never an invented figure.",
    fineprint: "Your details are only used to arrange your visit.",
    getTitle: "What is included",
    getItems: [
      {
        title: "Scale and polish",
        body: "A thorough clean to remove plaque, tartar and surface staining.",
      },
      {
        title: "Seen by a hygienist",
        body: "Your clean is carried out by a trained dental hygienist.",
      },
      {
        title: "Home care advice",
        body: "Simple tips to keep your teeth and gums feeling fresh.",
      },
      {
        title: "Around 30 minutes",
        body: "Most hygiene visits take about half an hour.",
      },
    ],
  },

  faq: {
    head: {
      eyebrow: "Good to know",
      title: "Hygiene visit questions",
      intro: "A few common questions about a professional clean.",
    },
    items: [
      {
        q: "How often should I have a hygiene visit?",
        a: "Many people come every six months, and some benefit from more regular visits. Your dentist or hygienist can suggest what suits your teeth and gums.",
      },
      {
        q: "Does a scale and polish hurt?",
        a: "Most people find it comfortable. If your gums are tender, tell the hygienist and they will work gently and take their time.",
      },
      {
        q: "How long does a hygiene appointment take?",
        a: "Usually around 30 minutes, depending on how much build up there is to remove.",
      },
      {
        q: "Will it get rid of tea and coffee staining?",
        a: "A scale and polish lifts a lot of the surface staining from tea, coffee and everyday food and drink. Deeper staining within the tooth may need a different approach, which the hygienist can talk you through.",
      },
      {
        q: "What can I do to keep my teeth clean at home?",
        a: "The hygienist will show you simple ways to brush and clean between your teeth, so your mouth stays fresher for longer between visits.",
      },
    ],
  },

  footer: {
    brand: "Vitality Dental",
    tagline: "Dental hygiene",
    builtBy: "Built by Azen",
    compliance:
      "Our dentists and hygienists are GDC registered. Treatment suitability always depends on a clinical assessment.",
  },
};

// ---------------------------------------------------------------------------
// SHARED SHAPE FOR THE REMAINING FOUR TREATMENTS
// ---------------------------------------------------------------------------
// Static, user-visible COPY for the four remaining catalogue treatments that get a
// bespoke landing page: whitening, veneers, implant and checkup. They share ONE
// layout (a blend of the bonding + hygiene designs) so they share ONE interface and
// ONE renderer (components/landing/bespoke/vitality-treatment-landing.tsx), with a
// thin per-slug component supplying its corpus + authored icons. Kept in this module
// so the SAME registry compliance test enumerates every visible string and asserts
// scanBannedText finds zero hits, exactly as for the three pages above.
//
// COMPLIANCE (UK GDC/ASA + house style), same rules as the other bespoke copy:
//   - NO testimonials, patient quotes, star ratings or review counts. The patient
//     story + before/after sections are LABELLED PLACEHOLDERS (there are no real
//     photos yet), with the consent disclaimer kept.
//   - No em/en-dashes, no "$" (GBP only), no NHS/private/"payment plan"/"band"
//     funding words, no superlatives (best / leading / cheapest), no guarantees, no
//     pain-free claims.
//   - Clinical claims kept modest and honest per treatment: whitening "brightens" the
//     natural teeth (never permanent or guaranteed); veneers "improve the shape and
//     colour"; an implant is "a long lasting way to replace a missing tooth" (the
//     catalogue phrasing, never "permanent"); a checkup helps "catch anything early".
//   - Finance wording appears ONLY where the catalogue says financeAvailable is true
//     (whitening, veneers, implant). Checkup has NO finance, so its corpus carries no
//     0%/interest/"spread the cost" wording anywhere, like the hygiene page.
//   - Pricing uses the real catalogue "from" figure for each treatment (whitening 350,
//     veneers 450, implant 2,400, checkup 60). No invented numbers.
// British English throughout. Per-variant hero + CTA copy is the A/B surface and lives
// in registry.ts, NOT here.

export interface TreatmentLandingCopy {
  header: HeaderCopy;
  /** Shared hero eyebrow (the accented headline + subhead are the A/B surface, in registry.ts). */
  heroEyebrow: string;
  heroPills: string[];
  /** Small factual trust chips (value + label). No ratings, reviews or awards. */
  trust: { value: string; label: string }[];
  form: FormCopy;
  /** "Sound familiar?" empathy grid: six line-icon cards (paired with icons by index) + banner. */
  painPoints: {
    head: CenterHeadCopy;
    items: TitledPair[];
    banner: { lead: string; accent: string; tail: string };
  };
  treatment: {
    head: SplitHeadCopy;
    aboutTitle: string;
    aboutBody: string;
    keyFactsTitle: string;
    keyFacts: string[];
    stepsEyebrow: string;
    /** Four steps. */
    steps: TitledPair[];
  };
  /** "What it helps with": six line-icon cards (paired with icons by index). */
  helps: {
    head: CenterHeadCopy;
    items: TitledPair[];
  };
  /** Placeholder patient-story slots (no real photos yet). */
  stories: {
    head: SplitHeadCopy;
    placeholderTitle: string;
    placeholderNote: string;
  };
  /** Placeholder before/after slots (no real photos yet) + kept consent disclaimer. */
  beforeAfter: {
    head: CenterHeadCopy;
    placeholderTitle: string;
    placeholderNote: string;
    capTitle: string;
    capNote: string;
    disclaimer: string;
  };
  why: {
    head: CenterHeadCopy;
    items: TitledPair[];
  };
  pricing: {
    head: CenterHeadCopy;
    priceEyebrow: string;
    priceLabel: string;
    /** Finance chip + note: present ONLY where the catalogue says financeAvailable is true. */
    financeChip?: string;
    financeNote?: string;
    /** Finance-free note (the checkup equivalent of the finance note above). */
    priceNote?: string;
    fineprint: string;
    getTitle: string;
    getItems: TitledPair[];
  };
  faq: {
    head: CenterHeadCopy;
    items: { q: string; a: string }[];
  };
  footer: {
    brand: string;
    tagline: string;
    builtBy: string;
    compliance: string;
  };
}

// Shared, identical-across-treatments form fields. The five treatment-specific fields
// (eyebrow, heading, subheading, messagePlaceholder, submitFallback, fineprint,
// successBody) are supplied per corpus via bespokeForm().
const BESPOKE_FORM_BASE = {
  nameLabel: "Full name",
  namePlaceholder: "Your full name",
  phoneLabel: "Mobile number",
  phonePlaceholder: "07700 900123",
  emailLabel: "Email address",
  emailPlaceholder: "you@example.com",
  contactHint: "Add a mobile number or an email so the team can reach you.",
  channelLabel: "How should we reach you?",
  channelWhatsApp: "WhatsApp",
  channelSms: "SMS",
  channelEmail: "Email",
  messageLabel: "Your message (optional)",
  consentLabel: "I agree to be contacted about my enquiry.",
  successTitle: "Thanks, your enquiry is in.",
  errorGeneric: "Something went wrong. Please try again, or call the practice.",
  errorName: "Please enter your name.",
  errorContact: "Please add a mobile number or an email address.",
  errorConsent: "Please tick the box so we can contact you about your enquiry.",
} as const;

function bespokeForm(over: {
  eyebrow: string;
  heading: string;
  subheading: string;
  messagePlaceholder: string;
  submitFallback: string;
  fineprint: string;
  successBody: string;
}): FormCopy {
  return { ...BESPOKE_FORM_BASE, ...over };
}

// ---------------------------------------------------------------------------
// WHITENING (teeth whitening, from GBP 350, finance available)
// ---------------------------------------------------------------------------
export const WHITENING_LANDING_COPY: TreatmentLandingCopy = {
  header: { brand: "VITALITY DENTAL" },

  heroEyebrow: "Brighten your smile",

  heroPills: ["Brighter smile", "Home or in chair", "0% finance available", "Often a single visit"],

  trust: [
    { value: "0%", label: "Finance available" },
    { value: "£350", label: "Whitening from" },
  ],

  form: bespokeForm({
    eyebrow: "Free consultation",
    heading: "See if teeth whitening is right for you",
    subheading: "Book free. No commitment, and no pressure.",
    messagePlaceholder: "Tell us what you would like to brighten, or ask a question",
    submitFallback: "Book my free consultation",
    fineprint: "Your details are only used to arrange your consultation.",
    successBody: "The team will be in touch shortly to arrange your free consultation.",
  }),

  painPoints: {
    head: {
      eyebrow: "Sound familiar?",
      title: "You would love a brighter smile",
      intro:
        "Most people who ask about whitening have wanted a brighter smile for a while. Everyday food and drink dull teeth over time.",
    },
    items: [
      {
        title: "Tea, coffee and red wine",
        body: "Everyday cups and glasses leave your teeth looking duller than they used to.",
      },
      {
        title: "Teeth look yellow in photos",
        body: "You notice the colour of your teeth in photos, and it holds you back from smiling fully.",
      },
      {
        title: "Brushing does not shift it",
        body: "However well you brush at home, the shade of your teeth has not really changed.",
      },
      {
        title: "Kits from the shop disappoint",
        body: "Kits and pastes from the shop have not made much of a difference to the colour.",
      },
      {
        title: "A big event coming up",
        body: "A wedding, a holiday or a special occasion, and you would like your smile to look its brightest.",
      },
      {
        title: "Teeth dull with age",
        body: "Teeth naturally lose some brightness over the years, and you would like to freshen yours up.",
      },
    ],
    banner: {
      lead: "Professional whitening lifts everyday staining ",
      accent: "for a brighter smile",
      tail: ", using a safe, dentist led approach.",
    },
  },

  treatment: {
    head: {
      eyebrow: "The treatment",
      title: "Professional whitening, guided by a dentist",
      intro:
        "Whitening uses a dentist led gel to gently lift staining and brighten your teeth, with a home kit, an in chair treatment, or both, planned around the shade you would like.",
    },
    aboutTitle: "What is teeth whitening?",
    aboutBody:
      "Teeth whitening is a safe way to brighten your smile, carried out or supervised by a dentist. It uses a whitening gel that gently lifts the everyday staining that builds up on your teeth from food, drink and time. You can whiten at home with custom trays worn for a set period each day, have an in chair treatment at the practice, or combine the two. Your dentist checks your teeth and gums first, then plans the approach and target shade with you. Whitening brightens your natural teeth, and your shade can be topped up over time. It does not change the colour of fillings, crowns or veneers.",
    keyFactsTitle: "Key facts",
    keyFacts: [
      "Home or in chair",
      "Dentist led",
      "Brightens natural teeth",
      "0% finance available",
      "Free initial consultation",
    ],
    stepsEyebrow: "How it works",
    steps: [
      {
        title: "Free consultation",
        body: "We check your teeth and gums, talk through the shade you would like, and confirm whitening suits you.",
      },
      {
        title: "Custom trays or in chair",
        body: "We take a scan or impression for custom trays, or plan your in chair treatment at the practice.",
      },
      {
        title: "Whiten gradually",
        body: "You whiten at home over a set period, or in the chair, building towards the shade you are after.",
      },
      {
        title: "See your result",
        body: "We look over your result together, and share simple tips to help keep your smile looking bright.",
      },
    ],
  },

  helps: {
    head: {
      eyebrow: "What it helps with",
      title: "What professional whitening helps with",
    },
    items: [
      {
        title: "Everyday staining",
        body: "Lifts the surface staining that tea, coffee, wine and food leave behind over time.",
      },
      {
        title: "A duller shade",
        body: "Brightens teeth that have lost some of their natural brightness over the years.",
      },
      {
        title: "A lift before an event",
        body: "A brighter smile for a wedding, a holiday or a special occasion.",
      },
      {
        title: "A confidence boost",
        body: "Many people feel happier smiling fully once their teeth look a little brighter.",
      },
      {
        title: "A dentist led approach",
        body: "Whitening planned and supervised by a dentist, rather than an off the shelf kit.",
      },
      {
        title: "A result you can top up",
        body: "Your shade can be refreshed over time with the trays your dentist provides.",
      },
    ],
  },

  stories: {
    head: {
      eyebrow: "Patient stories",
      title: "Real patients, real results",
      intro:
        "We are adding consented photos of real Vitality Dental whitening results. In the meantime, your dentist can show you examples at your consultation.",
    },
    placeholderTitle: "Your consented whitening result here",
    placeholderNote: "Real patient photos will appear here once added, with written consent.",
  },

  beforeAfter: {
    head: {
      eyebrow: "Results",
      title: "Before and after",
      intro:
        "Every smile starts from a different shade, and your dentist will talk through what whitening can realistically achieve for you.",
    },
    placeholderTitle: "Your consented whitening result here",
    placeholderNote: "Before and after photos will be added once the practice has consented cases to show.",
    capTitle: "Before and after",
    capNote: "Photo coming soon",
    disclaimer:
      "Individual results vary. Before and after images will be of genuine Vitality Dental patients, shown with their written consent.",
  },

  why: {
    head: { eyebrow: "Why Vitality Dental", title: "Whitening, done properly" },
    items: [
      {
        title: "Dentist led",
        body: "Every whitening plan is checked by a GDC registered dentist before treatment begins.",
      },
      {
        title: "Clinician-led care",
        body: "You are looked after by an experienced clinician who plans your whitening personally.",
      },
      {
        title: "Home or in chair",
        body: "Whiten at home with custom trays, in the chair, or a combination of the two.",
      },
      {
        title: "Easy to get to",
        body: "Convenient and welcoming, with flexible appointment times around your schedule.",
      },
      {
        title: "0% interest-free finance",
        body: "Spread the cost with no added interest. Start today without paying everything upfront.",
      },
      {
        title: "Honest, unrushed advice",
        body: "We talk through what whitening can and cannot do, so you know what to expect.",
      },
    ],
  },

  pricing: {
    head: {
      eyebrow: "Pricing",
      title: "Clear pricing, no surprises.",
      intro:
        "The cost of whitening depends on whether you choose a home kit, an in chair treatment, or both. Your exact price is confirmed at your free consultation.",
    },
    priceEyebrow: "Teeth whitening starts from",
    priceLabel: "£350",
    financeChip: "0% finance available",
    financeNote:
      "Spread the cost with no added interest. Your exact price is confirmed after a clinical assessment, and is always the real catalogue price, never an invented figure.",
    fineprint: "Your details are only used to arrange your consultation.",
    getTitle: "What you get",
    getItems: [
      { title: "Dentist led whitening", body: "Planned and supervised by a GDC registered dentist." },
      {
        title: "Free initial consultation",
        body: "No cost, no commitment. See if whitening is right for you.",
      },
      { title: "0% interest-free finance", body: "Start today without paying everything upfront." },
      { title: "Custom fitted trays", body: "Made to fit your teeth for even, comfortable whitening at home." },
    ],
  },

  faq: {
    head: {
      eyebrow: "Good to know",
      title: "Teeth whitening questions",
      intro: "A few common questions about professional whitening.",
    },
    items: [
      {
        q: "Is teeth whitening safe?",
        a: "Whitening carried out or supervised by a dentist is a safe way to brighten your teeth. Your dentist checks your teeth and gums first and plans a suitable approach with you.",
      },
      {
        q: "Will whitening make my teeth sensitive?",
        a: "Some people notice mild, short lived sensitivity during whitening. Tell your dentist and they can adjust the approach and suggest ways to keep you comfortable.",
      },
      {
        q: "How long do the results last?",
        a: "Whitening brightens your natural teeth, and everyday food and drink can dull them again over time. Your shade can be topped up with the trays your dentist provides.",
      },
      {
        q: "Does whitening work on fillings or crowns?",
        a: "Whitening brightens natural teeth but does not change the colour of fillings, crowns or veneers. Your dentist will talk through your options if you have these.",
      },
      {
        q: "Home kit or in chair, which is right for me?",
        a: "Both can work well. Your dentist will talk through the difference at your consultation and help you choose based on your teeth and what suits you.",
      },
    ],
  },

  footer: {
    brand: "Vitality Dental",
    tagline: "Teeth whitening",
    builtBy: "Built by Azen",
    compliance:
      "Our dentists are GDC registered. Treatment suitability always depends on a clinical assessment.",
  },
};

// ---------------------------------------------------------------------------
// VENEERS (from GBP 450, finance available)
// ---------------------------------------------------------------------------
export const VENEERS_LANDING_COPY: TreatmentLandingCopy = {
  header: { brand: "VITALITY DENTAL" },

  heroEyebrow: "Reshape and refine your smile",

  heroPills: ["Custom made", "Shape and colour", "0% finance available", "Natural looking"],

  trust: [
    { value: "0%", label: "Finance available" },
    { value: "£450", label: "Veneers from" },
  ],

  form: bespokeForm({
    eyebrow: "Free consultation",
    heading: "See if veneers are right for you",
    subheading: "Book free. No commitment, and no pressure.",
    messagePlaceholder: "Tell us what you would like to change, or ask a question",
    submitFallback: "Book my free consultation",
    fineprint: "Your details are only used to arrange your consultation.",
    successBody: "The team will be in touch shortly to arrange your free consultation.",
  }),

  painPoints: {
    head: {
      eyebrow: "Sound familiar?",
      title: "You would like to change how your teeth look",
      intro:
        "Most people who ask about veneers have wanted to change the shape or colour of their front teeth for a while.",
    },
    items: [
      {
        title: "Teeth that look worn",
        body: "Front teeth that have worn down or lost their shape over the years.",
      },
      {
        title: "Discolouration that will not lift",
        body: "A shade or marks on your teeth that whitening alone does not fully change.",
      },
      {
        title: "Uneven or chipped edges",
        body: "Edges that look uneven, chipped or a little short when you smile.",
      },
      {
        title: "Small gaps at the front",
        body: "Spaces between your front teeth that show every time you smile.",
      },
      {
        title: "Teeth that look small",
        body: "Teeth that look small or out of proportion next to the ones around them.",
      },
      {
        title: "Wanting a fuller change",
        body: "You would like a bigger change to your smile than whitening or bonding alone can give.",
      },
    ],
    banner: {
      lead: "Veneers are thin covers bonded to the front of your teeth ",
      accent: "to improve their shape and colour",
      tail: ", for a natural looking result.",
    },
  },

  treatment: {
    head: {
      eyebrow: "The treatment",
      title: "Custom veneers, shaped to suit your smile",
      intro:
        "Veneers are thin, custom made covers bonded to the front of your teeth to improve their shape, colour and overall look, planned around the smile you would like.",
    },
    aboutTitle: "What are veneers?",
    aboutBody:
      "Veneers are thin covers, usually made of porcelain or a composite material, that are bonded to the front of your teeth to improve their shape, colour and overall look. They can even up worn or chipped edges, mask discolouration that whitening does not lift, close small gaps, and bring your front teeth into better proportion. Your dentist assesses your teeth and gums, talks through the look you would like, and plans your veneers around your natural features. Some preparation of the tooth may be needed so the veneer sits flush. Veneers are a longer term change, and your dentist will talk through how to care for them and what to expect over time.",
    keyFactsTitle: "Key facts",
    keyFacts: [
      "Custom made",
      "Shape and colour",
      "Natural looking",
      "0% finance available",
      "Free initial consultation",
    ],
    stepsEyebrow: "How it works",
    steps: [
      {
        title: "Free consultation",
        body: "We assess your teeth and gums, talk through the look you would like, and check that veneers suit you.",
      },
      {
        title: "Plan and design",
        body: "Your dentist plans the shape, colour and number of veneers around your natural features.",
      },
      {
        title: "Prepare and fit",
        body: "Any preparation is done, your custom veneers are made, then bonded to the front of your teeth.",
      },
      {
        title: "See your smile",
        body: "We check the fit and finish together, and share simple tips to help your veneers last.",
      },
    ],
  },

  helps: {
    head: { eyebrow: "What it helps with", title: "What veneers can help with" },
    items: [
      {
        title: "Shape and proportion",
        body: "Even up worn, short or uneven front teeth for a more balanced smile.",
      },
      {
        title: "Discolouration",
        body: "Mask staining or marks on a tooth that whitening on its own does not lift.",
      },
      {
        title: "Chipped edges",
        body: "Cover chipped or worn edges for a smoother, more even look.",
      },
      {
        title: "Small gaps",
        body: "Close or narrow small spaces between the front teeth.",
      },
      {
        title: "A fuller change",
        body: "A bigger change to the look of your smile than whitening or bonding alone.",
      },
      {
        title: "A natural finish",
        body: "Veneers are shaped and shade matched to look natural alongside your other teeth.",
      },
    ],
  },

  stories: {
    head: {
      eyebrow: "Patient stories",
      title: "Real patients, real results",
      intro:
        "We are adding consented photos of real Vitality Dental veneer cases. In the meantime, your dentist can show you examples at your consultation.",
    },
    placeholderTitle: "Your consented veneer case here",
    placeholderNote: "Real patient photos will appear here once added, with written consent.",
  },

  beforeAfter: {
    head: {
      eyebrow: "Results",
      title: "Before and after",
      intro:
        "Every smile is different, and your dentist will talk through what veneers can realistically achieve for your teeth.",
    },
    placeholderTitle: "Your consented veneer case here",
    placeholderNote: "Before and after photos will be added once the practice has consented cases to show.",
    capTitle: "Before and after",
    capNote: "Photo coming soon",
    disclaimer:
      "Individual results vary. Before and after images will be of genuine Vitality Dental patients, shown with their written consent.",
  },

  why: {
    head: { eyebrow: "Why Vitality Dental", title: "Veneers, done properly" },
    items: [
      {
        title: "Clinically assessed",
        body: "Every case is assessed by a GDC registered dentist before any treatment begins.",
      },
      {
        title: "Clinician-led care",
        body: "You are treated by an experienced clinician who plans and fits your veneers personally.",
      },
      {
        title: "Shade and shape matched",
        body: "Your veneers are designed around your natural features for a natural looking result.",
      },
      {
        title: "Easy to get to",
        body: "Convenient and welcoming, with flexible appointment times around your schedule.",
      },
      {
        title: "0% interest-free finance",
        body: "Spread the cost with no added interest. Start today without paying everything upfront.",
      },
      {
        title: "Honest, unrushed advice",
        body: "We talk through what veneers can and cannot do, so you can decide what is right for you.",
      },
    ],
  },

  pricing: {
    head: {
      eyebrow: "Pricing",
      title: "Clear pricing, no surprises.",
      intro:
        "The cost of veneers depends on the material and how many teeth are treated. Your exact price is confirmed at your free consultation.",
    },
    priceEyebrow: "Veneers start from",
    priceLabel: "£450",
    financeChip: "0% finance available",
    financeNote:
      "Spread the cost with no added interest. Your exact price is confirmed after a clinical assessment, and is always the real catalogue price, never an invented figure.",
    fineprint: "Your details are only used to arrange your consultation.",
    getTitle: "What you get",
    getItems: [
      { title: "Custom made veneers", body: "Designed around your natural features for a natural looking result." },
      {
        title: "Free initial consultation",
        body: "No cost, no commitment. See if veneers are right for you.",
      },
      { title: "0% interest-free finance", body: "Start today without paying everything upfront." },
      { title: "A planned smile design", body: "Shape, colour and number planned with your dentist before you start." },
    ],
  },

  faq: {
    head: {
      eyebrow: "Good to know",
      title: "Veneer questions",
      intro: "A few common questions about veneers.",
    },
    items: [
      {
        q: "How long do veneers last?",
        a: "Veneers are a longer term change and can last for years with good care. Your dentist will talk through how to look after them and what to expect over time.",
      },
      {
        q: "Do veneers look natural?",
        a: "Veneers are shaped and shade matched to blend with your other teeth. Your dentist plans them around your natural features so the result looks natural.",
      },
      {
        q: "Will my teeth need preparing?",
        a: "Some veneers need a little preparation of the tooth so they sit flush, while others need very little. Your dentist will explain what your case involves.",
      },
      {
        q: "Veneers, whitening or bonding, which is right for me?",
        a: "It depends on what you would like to change. Your dentist will talk through the options at your consultation and help you choose what suits your teeth.",
      },
      {
        q: "Can I spread the cost?",
        a: "Yes, 0% finance is available. We can go through the options with you at your consultation.",
      },
    ],
  },

  footer: {
    brand: "Vitality Dental",
    tagline: "Veneers",
    builtBy: "Built by Azen",
    compliance:
      "Our dentists are GDC registered. Treatment suitability always depends on a clinical assessment.",
  },
};

// ---------------------------------------------------------------------------
// IMPLANT (dental implant, from GBP 2,400, finance available)
// ---------------------------------------------------------------------------
export const IMPLANT_LANDING_COPY: TreatmentLandingCopy = {
  header: { brand: "VITALITY DENTAL" },

  heroEyebrow: "Replace a missing tooth",

  heroPills: ["Long lasting", "Natural looking crown", "0% finance available", "Fixed in place"],

  trust: [
    { value: "0%", label: "Finance available" },
    { value: "£2,400", label: "Implants from" },
  ],

  form: bespokeForm({
    eyebrow: "Free consultation",
    heading: "See if a dental implant is right for you",
    subheading: "Book free. No commitment, and no pressure.",
    messagePlaceholder: "Tell us about the tooth you would like to replace, or ask a question",
    submitFallback: "Book my free consultation",
    fineprint: "Your details are only used to arrange your consultation.",
    successBody: "The team will be in touch shortly to arrange your free consultation.",
  }),

  painPoints: {
    head: {
      eyebrow: "Sound familiar?",
      title: "Living with a missing tooth",
      intro:
        "Most people who ask about implants have managed around a missing tooth or a loose denture for a while.",
    },
    items: [
      {
        title: "A gap when you smile",
        body: "A missing tooth that shows when you smile, or that you find yourself trying to hide.",
      },
      {
        title: "Trouble chewing on one side",
        body: "You favour one side when you eat because a gap or loose tooth makes chewing harder.",
      },
      {
        title: "A denture that moves",
        body: "A denture that slips or feels bulky, and you would like something more secure.",
      },
      {
        title: "A tooth that came out",
        body: "A tooth lost to injury or decay that you have never had replaced.",
      },
      {
        title: "Worried about the gap",
        body: "You have heard that a gap can affect the teeth around it, and you would like to sort it.",
      },
      {
        title: "Wanting a fixed option",
        body: "You would prefer a fixed replacement rather than something you take in and out.",
      },
    ],
    banner: {
      lead: "A dental implant is ",
      accent: "a long lasting way to replace a missing tooth",
      tail: ", with a natural looking crown fixed in place.",
    },
  },

  treatment: {
    head: {
      eyebrow: "The treatment",
      title: "A dental implant, fixed in place",
      intro:
        "A dental implant is a small fixture that replaces the root of a missing tooth and supports a natural looking crown, a long lasting way to fill the gap without relying on the teeth around it.",
    },
    aboutTitle: "What is a dental implant?",
    aboutBody:
      "A dental implant is a small fixture, usually titanium, that is placed into the jaw to replace the root of a missing tooth. Once it has healed and settled, it supports a natural looking crown that fills the gap and lets you bite and smile with confidence. Unlike a bridge, an implant does not rely on the teeth on either side, and unlike a denture it stays fixed in place. It is a long lasting way to replace a missing tooth. Your dentist assesses your teeth, gums and jaw first, plans the treatment over a few visits, and talks through what to expect at each stage and how to care for your implant.",
    keyFactsTitle: "Key facts",
    keyFacts: [
      "Long lasting",
      "Fixed in place",
      "Natural looking crown",
      "0% finance available",
      "Free initial consultation",
    ],
    stepsEyebrow: "How it works",
    steps: [
      {
        title: "Free consultation",
        body: "We assess your teeth, gums and jaw, talk through your options, and check that an implant suits you.",
      },
      {
        title: "Plan and place",
        body: "Your treatment is planned, then the implant is placed into the jaw at the site of the missing tooth.",
      },
      {
        title: "Heal and settle",
        body: "The implant is given time to heal and settle firmly into place before the next stage.",
      },
      {
        title: "Fit your crown",
        body: "A natural looking crown is made and fixed onto the implant, completing your new tooth.",
      },
    ],
  },

  helps: {
    head: { eyebrow: "What it helps with", title: "What a dental implant helps with" },
    items: [
      {
        title: "A single missing tooth",
        body: "Fills the gap left by one missing tooth without relying on the teeth beside it.",
      },
      {
        title: "Chewing with confidence",
        body: "A fixed replacement that lets you bite and chew more comfortably.",
      },
      {
        title: "An alternative to a denture",
        body: "A fixed option for people who would rather not have a denture that moves.",
      },
      {
        title: "Keeping the gap supported",
        body: "Replaces the missing tooth so the gap is filled and supported.",
      },
      {
        title: "A natural looking result",
        body: "The crown is shaped and shade matched to look natural alongside your other teeth.",
      },
      {
        title: "A long lasting solution",
        body: "A long lasting way to replace a missing tooth, cared for like your natural teeth.",
      },
    ],
  },

  stories: {
    head: {
      eyebrow: "Patient stories",
      title: "Real patients, real results",
      intro:
        "We are adding consented photos of real Vitality Dental implant cases. In the meantime, your dentist can show you examples at your consultation.",
    },
    placeholderTitle: "Your consented implant case here",
    placeholderNote: "Real patient photos will appear here once added, with written consent.",
  },

  beforeAfter: {
    head: {
      eyebrow: "Results",
      title: "Before and after",
      intro:
        "Every case is different, and your dentist will talk through what a dental implant can realistically achieve for you.",
    },
    placeholderTitle: "Your consented implant case here",
    placeholderNote: "Before and after photos will be added once the practice has consented cases to show.",
    capTitle: "Before and after",
    capNote: "Photo coming soon",
    disclaimer:
      "Individual results vary. Before and after images will be of genuine Vitality Dental patients, shown with their written consent.",
  },

  why: {
    head: { eyebrow: "Why Vitality Dental", title: "Implants, done properly" },
    items: [
      {
        title: "Clinically assessed",
        body: "Every case is assessed by a GDC registered dentist before any treatment begins.",
      },
      {
        title: "Clinician-led care",
        body: "You are treated by an experienced clinician who plans and carries out your implant personally.",
      },
      {
        title: "Planned over a few visits",
        body: "Your treatment is planned carefully and carried out in stages, at a pace that suits you.",
      },
      {
        title: "Easy to get to",
        body: "Convenient and welcoming, with flexible appointment times around your schedule.",
      },
      {
        title: "0% interest-free finance",
        body: "Spread the cost with no added interest. Start today without paying everything upfront.",
      },
      {
        title: "Honest, unrushed advice",
        body: "We talk through what an implant involves, so you know what to expect at each stage.",
      },
    ],
  },

  pricing: {
    head: {
      eyebrow: "Pricing",
      title: "Clear pricing, no surprises.",
      intro:
        "The cost of an implant depends on your case and whether any other treatment is needed first. Your exact price is confirmed at your free consultation.",
    },
    priceEyebrow: "Dental implants start from",
    priceLabel: "£2,400",
    financeChip: "0% finance available",
    financeNote:
      "Spread the cost with no added interest. Your exact price is confirmed after a clinical assessment, and is always the real catalogue price, never an invented figure.",
    fineprint: "Your details are only used to arrange your consultation.",
    getTitle: "What you get",
    getItems: [
      { title: "A planned implant treatment", body: "Assessed and planned by a GDC registered dentist." },
      {
        title: "Free initial consultation",
        body: "No cost, no commitment. See if an implant is right for you.",
      },
      { title: "0% interest-free finance", body: "Start today without paying everything upfront." },
      { title: "A natural looking crown", body: "Shaped and shade matched to look natural alongside your other teeth." },
    ],
  },

  faq: {
    head: {
      eyebrow: "Good to know",
      title: "Dental implant questions",
      intro: "A few common questions about dental implants.",
    },
    items: [
      {
        q: "How long does an implant last?",
        a: "An implant is a long lasting way to replace a missing tooth and can last for years with good care. Your dentist will talk through how to look after it.",
      },
      {
        q: "How long does the treatment take?",
        a: "Implant treatment is carried out over a few visits, with healing time in between. Your dentist will explain the timeline for your case at your consultation.",
      },
      {
        q: "Will having an implant placed be uncomfortable?",
        a: "The area is numbed for the procedure and most people find it very manageable. Tell your dentist about any concerns and they will talk you through it.",
      },
      {
        q: "Is an implant right for me?",
        a: "Suitability depends on a clinical assessment of your teeth, gums and jaw. Book a consultation and we will talk through your options.",
      },
      {
        q: "Can I spread the cost?",
        a: "Yes, 0% finance is available. We can go through the options with you at your consultation.",
      },
    ],
  },

  footer: {
    brand: "Vitality Dental",
    tagline: "Dental implants",
    builtBy: "Built by Azen",
    compliance:
      "Our dentists are GDC registered. Treatment suitability always depends on a clinical assessment.",
  },
};

// ---------------------------------------------------------------------------
// CHECKUP (routine dental checkup, from GBP 60, NO finance)
// ---------------------------------------------------------------------------
// Checkup has NO finance (catalog financeAvailable is false), so this corpus carries
// no 0%/interest/"spread the cost" wording anywhere, like the hygiene page. The
// before/after section is reframed honestly as practice photos (a checkup is not a
// cosmetic transformation), still a LABELLED PLACEHOLDER with a consent line.
export const CHECKUP_LANDING_COPY: TreatmentLandingCopy = {
  header: { brand: "VITALITY DENTAL" },

  heroEyebrow: "A routine dental checkup",

  heroPills: ["With the dentist", "Teeth and gums checked", "Same week appointments", "Catch issues early"],

  trust: [
    { value: "£60", label: "Checkup from" },
    { value: "30 min", label: "Usually per visit" },
  ],

  form: bespokeForm({
    eyebrow: "Book a checkup",
    heading: "Book your dental checkup",
    subheading: "Book your visit. No pressure, and no obligation.",
    messagePlaceholder: "Tell us about anything you have noticed, or when your last checkup was",
    submitFallback: "Book my checkup",
    fineprint: "Your details are only used to arrange your visit.",
    successBody: "The team will be in touch shortly to arrange your checkup.",
  }),

  painPoints: {
    head: {
      eyebrow: "Sound familiar?",
      title: "It has been a while since your last checkup",
      intro:
        "Life gets busy, and a routine checkup is easy to put off. A regular visit helps catch small things before they grow.",
    },
    items: [
      {
        title: "It has been a while",
        body: "Longer than you would like since you last saw a dentist for a checkup.",
      },
      {
        title: "A niggle you are unsure about",
        body: "A twinge, a sensitive spot, or something that does not feel quite right.",
      },
      {
        title: "New to the area",
        body: "You have moved and have not found a regular dentist yet.",
      },
      {
        title: "Kept meaning to book",
        body: "A checkup has been on your list, but you have never quite got round to it.",
      },
      {
        title: "Want peace of mind",
        body: "You would simply like to know that your teeth and gums are healthy.",
      },
      {
        title: "Keeping on top of things",
        body: "You would like to stay on top of your dental health with regular visits.",
      },
    ],
    banner: {
      lead: "A routine checkup lets the dentist ",
      accent: "catch small things early",
      tail: ", and keep your teeth and gums healthy.",
    },
  },

  treatment: {
    head: {
      eyebrow: "The visit",
      title: "A routine checkup with the dentist",
      intro:
        "A checkup is a straightforward examination with the dentist, a look at your teeth, gums and mouth to check everything is healthy and to catch anything early.",
    },
    aboutTitle: "What is a dental checkup?",
    aboutBody:
      "A dental checkup is a routine examination with the dentist. They look over your teeth, gums and mouth to check that everything is healthy, and to spot any early signs of decay, gum problems or wear before they grow into something bigger. The dentist may take X-rays if needed, talk through anything they find, and suggest whether any treatment or a hygiene visit would help. It is also a good moment to ask about anything you have noticed. Seeing the dentist regularly helps keep your teeth and gums healthy and makes any problems easier to deal with while they are still small.",
    keyFactsTitle: "Key facts",
    keyFacts: [
      "With the dentist",
      "Teeth, gums and mouth checked",
      "X-rays if needed",
      "Same week appointments usually",
      "Advice you can use",
    ],
    stepsEyebrow: "How it works",
    steps: [
      {
        title: "Book your visit",
        body: "Get in touch and we will find you a checkup appointment, often within the same week.",
      },
      {
        title: "A friendly chat",
        body: "The dentist asks how you have been getting on and about anything you have noticed.",
      },
      {
        title: "The examination",
        body: "The dentist checks your teeth, gums and mouth, and takes X-rays if they are needed.",
      },
      {
        title: "Your plan",
        body: "You talk through anything found, and any treatment or hygiene visit that would help.",
      },
    ],
  },

  helps: {
    head: { eyebrow: "What it helps with", title: "What a routine checkup helps with" },
    items: [
      {
        title: "Catching decay early",
        body: "The dentist can spot early signs of decay before they turn into something bigger.",
      },
      {
        title: "Gum health",
        body: "A checkup keeps an eye on your gums and flags any early gum problems.",
      },
      {
        title: "Wear and grinding",
        body: "Signs of wear or grinding can be picked up and talked through.",
      },
      {
        title: "Peace of mind",
        body: "A clear picture of how your teeth and gums are doing.",
      },
      {
        title: "A plan for anything found",
        body: "If something needs attention, you leave with a clear idea of what helps.",
      },
      {
        title: "Regular upkeep",
        body: "Regular visits keep small things small and your mouth healthy.",
      },
    ],
  },

  stories: {
    head: {
      eyebrow: "Meet the team",
      title: "Looking after local smiles",
      intro:
        "We are adding photos of the practice and the team. In the meantime, the team is happy to answer any questions when you book.",
    },
    placeholderTitle: "A friendly, familiar face here",
    placeholderNote: "Photos of the team will appear here once added, with consent.",
  },

  beforeAfter: {
    head: {
      eyebrow: "The practice",
      title: "A calm, welcoming visit",
      intro:
        "We are adding photos of the practice and the team. In the meantime, the team is happy to help with any questions when you book.",
    },
    placeholderTitle: "A calm, welcoming practice here",
    placeholderNote: "Photos of the practice and team will be added once available.",
    capTitle: "At the practice",
    capNote: "Photo coming soon",
    disclaimer: "Photos will be of the genuine Vitality Dental practice and team, added with consent.",
  },

  why: {
    head: { eyebrow: "Why Vitality Dental", title: "Checkups, done properly" },
    items: [
      {
        title: "GDC registered dentists",
        body: "Your checkup is carried out by a GDC registered dentist.",
      },
      {
        title: "Unhurried care",
        body: "We take our time, listen, and explain what we find in plain language.",
      },
      {
        title: "Same week appointments",
        body: "Same week checkup appointments are usually available when you need one.",
      },
      {
        title: "Easy to get to",
        body: "Convenient and welcoming, with flexible appointment times around your schedule.",
      },
      {
        title: "Clear pricing",
        body: "A checkup from £60, confirmed with you before anything goes ahead.",
      },
      {
        title: "Advice you can use",
        body: "Practical, honest advice for keeping your teeth and gums healthy at home.",
      },
    ],
  },

  pricing: {
    head: {
      eyebrow: "Pricing",
      title: "Clear pricing, no surprises.",
      intro:
        "A routine checkup is £60. Your exact price is always confirmed with you before your appointment goes ahead.",
    },
    priceEyebrow: "Checkup from",
    priceLabel: "£60",
    priceNote:
      "Your price is confirmed before treatment, and is always the real catalogue price, never an invented figure.",
    fineprint: "Your details are only used to arrange your visit.",
    getTitle: "What is included",
    getItems: [
      { title: "An examination with the dentist", body: "A check of your teeth, gums and mouth." },
      { title: "X-rays if needed", body: "Taken only where they help the dentist see more." },
      { title: "Advice and a plan", body: "A clear idea of anything found and what would help." },
      { title: "Same week appointments usually", body: "We aim to see you promptly when you need a checkup." },
    ],
  },

  faq: {
    head: {
      eyebrow: "Good to know",
      title: "Checkup questions",
      intro: "A few common questions about a routine checkup.",
    },
    items: [
      {
        q: "How often should I have a checkup?",
        a: "Many people come every six months, though the dentist may suggest more or less often depending on your teeth and gums. They will recommend what suits you.",
      },
      {
        q: "What happens at a checkup?",
        a: "The dentist looks over your teeth, gums and mouth, may take X-rays if needed, and talks through anything they find and what would help.",
      },
      {
        q: "Do I need X-rays every time?",
        a: "Not always. The dentist takes X-rays only when they help to see more, and will explain why if they are needed.",
      },
      {
        q: "How long does a checkup take?",
        a: "Most checkups take around thirty minutes. The dentist will let you know if you need any follow up.",
      },
      {
        q: "Can I have a checkup and a clean together?",
        a: "A checkup with the dentist and a hygiene visit work well together. The team can talk through booking both when you get in touch.",
      },
    ],
  },

  footer: {
    brand: "Vitality Dental",
    tagline: "Dental checkups",
    builtBy: "Built by Azen",
    compliance:
      "Our dentists are GDC registered. Treatment suitability always depends on a clinical assessment.",
  },
};
