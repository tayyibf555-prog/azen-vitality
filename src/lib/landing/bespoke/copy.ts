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
