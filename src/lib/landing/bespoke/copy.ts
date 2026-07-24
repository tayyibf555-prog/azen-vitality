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
  brandSub: string;
  locations: string;
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
    brandSub: "NORTH LONDON",
    locations: "N15, Vitality Dental group",
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
    { value: "N15", label: "North London" },
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
        title: "North London, easy to reach",
        body: "Based at N15, convenient and welcoming, with flexible appointment times around your schedule.",
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
    tagline: "Invisalign, N15 North London",
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
    brandSub: "NORTH LONDON",
    locations: "N15, Vitality Dental group",
  },

  heroEyebrow: "Repair chips, gaps and worn edges",

  heroPills: [
    "Tooth coloured",
    "Usually one visit",
    "0% finance available",
    "Minimal preparation",
  ],

  // Factual, non-proof chips (finance, the real from-price, location). No rating,
  // review or award claim, so they need no owner verification.
  trust: [
    { value: "0%", label: "Finance available" },
    { value: "£180", label: "Treatment from" },
    { value: "N15", label: "North London" },
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
      "Usually one visit",
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
        title: "North London, easy to reach",
        body: "Based at N15, convenient and welcoming, with flexible appointment times around your schedule.",
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
      { title: "Usually one visit", body: "Many cases are completed in a single appointment." },
    ],
  },

  footer: {
    brand: "Vitality Dental",
    tagline: "Composite bonding, N15 North London",
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
    brandSub: "NORTH LONDON",
    locations: "N15, Vitality Dental group",
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
    { value: "3 sites", label: "N15, N17 and Romford Road" },
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
        body: "Book at N15, N17 or Romford Road, whichever is easiest for you to reach.",
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
    tagline: "Dental hygiene, N15 North London",
    builtBy: "Built by Azen",
    compliance:
      "Our dentists and hygienists are GDC registered. Treatment suitability always depends on a clinical assessment.",
  },
};
