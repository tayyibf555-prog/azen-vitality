// Registry of BESPOKE, hand-designed landing templates.
//
// Most campaign landing pages render from a vetted, generated content object via
// the ONE generic renderer (components/landing/landing-content.tsx). A bespoke
// template is the exception: a hand-authored, treatment-specific design ported to
// its own server component. This registry is the seam that lets the public /go
// route branch to that component for a specific (client, slug), while everything
// else (variant assignment, the analytics tracker, the A/B stats, the draft
// preview flow) stays exactly the same.
//
// The DB row still exists (a real landing_page with two variants) so the page
// appears in Growth > Landing pages with Preview + A/B stats and its lead endpoint
// can confirm the page is live. But the bespoke COMPONENT does not read the DB
// variant content: its per-variant copy (the A/B surface) lives here, so the copy
// is code-reviewed and compliance-scanned alongside the design.
//
// THE A/B SURFACE. Variant a and b differ in the hero headline, the hero accent (a
// verbatim substring of the headline, highlighted in brand blue by the renderer),
// the hero subhead, the primary CTA label, and now an optional set of DESIGN flags
// (see `layout`) that let variant b differ in LAYOUT/STRUCTURE, not just wording.
// Everything not named here is identical across variants.
//
// DESIGN FLAGS (layout). Optional, and present ONLY on the price/finance variant b:
// variant a carries no `layout` object at all, so it renders byte-identical to the
// original outcome-led design. The flags drive purely presentational, server-rendered
// extras (a fixed mobile CTA bar, a hero price chip) via the shared scoped stylesheet;
// they add no copy beyond the `heroPriceChip` strings, which are scanned like the rest.
//
// COMPLIANCE: every string below (including the heroPriceChip value + note) is scanned
// by scanBannedText in the registry test (British English, no dashes, no
// testimonials/superlatives/funding words).

/** The per-variant hero + CTA copy plus optional design flags: what differs a vs b. */
export interface BespokeVariantCopy {
  /** Full hero headline. */
  heroHeadline: string;
  /** A verbatim (case-insensitive) substring of heroHeadline to accent in blue. */
  heroAccent: string;
  /** Supporting hero paragraph. */
  heroSubhead: string;
  /** Primary CTA label (header button, pricing button, and the form submit). */
  ctaLabel: string;
  /**
   * Optional per-variant DESIGN flags. Present ONLY on variant b (the price/finance
   * angle); variant a omits this entirely so it stays structurally identical to today.
   * Each flag toggles a server-rendered, presentational-only extra defined in the
   * shared `.vd-landing` stylesheet.
   */
  layout?: {
    /** Render a fixed, full-width mobile CTA bar (shown under 820px only). */
    stickyCta?: boolean;
    /** Render a premium price chip under the hero subhead (value bold, note muted). */
    heroPriceChip?: {
      /** The headline figure, e.g. "From £2,500" or "£75". Real catalogue prices only. */
      value: string;
      /** A short muted note beside it, e.g. "0% finance available". */
      note: string;
    };
  };
}

export interface BespokeTemplate {
  /** Stable identifier for the ported design. */
  templateId: string;
  /** Catalogue treatment key (drives pricing + the DB row's treatment). */
  treatment: string;
  variants: {
    a: BespokeVariantCopy;
    b: BespokeVariantCopy;
  };
}

// Keyed by clientId (the resolved id, e.g. "vitality"), then slug. The public
// route and the component both resolve the clientId before looking up, so a client
// whose slug differs from its id still matches. Each templateId maps (in the /go
// render seam) to the ONE bespoke server component that renders it.
const BESPOKE_TEMPLATES: Record<string, Record<string, BespokeTemplate>> = {
  vitality: {
    invisalign: {
      templateId: "vitality-invisalign",
      treatment: "invisalign",
      variants: {
        // Variant A leads on the outcome + timeline.
        a: {
          heroHeadline: "A straighter smile with clear aligners",
          heroAccent: "clear aligners",
          heroSubhead:
            "Invisalign clear aligners at Vitality Dental. Virtually invisible, fully removable, and planned around your life. A confident, straighter smile without a single wire.",
          ctaLabel: "Book my free consultation",
        },
        // Variant B is the price/finance objection-breaker: it leads on the entry
        // price and 0% finance (the cost objection), against the outcome-led A.
        b: {
          heroHeadline: "Straighten your teeth from £2,500, with 0% finance",
          heroAccent: "0% finance",
          heroSubhead:
            "Invisalign clear aligners at Vitality Dental, mapped in 3D so you see your result before you start. Spread the cost with 0% finance, and book a free, unhurried consultation.",
          ctaLabel: "Check if I am suitable",
          // Design flags: variant b leads on price, so it earns a hero price chip and
          // a persistent mobile CTA bar. Variant a (above) carries no layout object.
        },
      },
    },
    // Composite bonding (seeded DRAFT; goes live once the practice supplies real
    // bonding photos). Same machinery as invisalign, its own bespoke component.
    bonding: {
      templateId: "vitality-bonding",
      treatment: "bonding",
      variants: {
        // Variant A leads on the outcome (a tidier smile) + the single-visit timeline.
        a: {
          heroHeadline: "A tidier smile, often in a single visit",
          heroAccent: "a single visit",
          heroSubhead:
            "Composite bonding at Vitality Dental. Tooth coloured material shaped onto your teeth to smooth away chips, close small gaps and refine uneven edges, usually in one appointment.",
          ctaLabel: "Book my free consultation",
        },
        // Variant B is the price objection-breaker: it leads on the entry price
        // (the cost objection), against the outcome-led A.
        b: {
          heroHeadline: "Repair a chipped tooth from £180",
          heroAccent: "from £180",
          heroSubhead:
            "Composite bonding at Vitality Dental shapes tooth coloured material onto the tooth to smooth chips, close small gaps and even up edges, usually in one visit. Book a free, no pressure consultation.",
          ctaLabel: "Book my free bonding consultation",
          // Design flags: the price-led variant b gets a hero price chip + mobile CTA
          // bar. Variant a (above) carries no layout object.
        },
      },
    },
    // Hygiene visit / scale and polish (seeded DRAFT). Same machinery as invisalign
    // and bonding, its own bespoke component, and it adds an interactive before/after
    // slider. Hygiene has NO finance, so the copy carries no 0%/interest wording.
    hygiene: {
      templateId: "vitality-hygiene",
      treatment: "hygiene",
      variants: {
        // Variant A leads on the outcome (a fresher, cleaner smile).
        a: {
          heroHeadline: "A fresher, cleaner smile starts here",
          heroAccent: "fresher, cleaner",
          heroSubhead:
            "A professional scale and polish with the hygienist at Vitality Dental. We lift plaque, tartar and everyday staining, and leave your teeth feeling fresh and clean.",
          ctaLabel: "Book my hygiene visit",
        },
        // Variant B is the price objection-breaker: it leads on the flat scale and
        // polish price (the cost objection), against the outcome-led A. No finance.
        b: {
          heroHeadline: "A professional scale and polish, £75",
          heroAccent: "£75",
          heroSubhead:
            "A thorough hygiene visit with the hygienist at Vitality Dental, usually about 30 minutes. We lift plaque, tartar and everyday staining, and leave your teeth feeling fresh and clean.",
          ctaLabel: "Book my scale and polish",
          // Design flags: the price-led variant b gets a hero price chip + mobile CTA
          // bar. NO finance wording (hygiene has no finance). Variant a carries no layout.
        },
      },
    },
    // Teeth whitening (seeded DRAFT). Same machinery + the shared bespoke renderer
    // (vitality-treatment-landing.tsx). Whitening has finance, so variant b leads on
    // the entry price + 0% finance. Modest claims only ("brighter", never permanent).
    whitening: {
      templateId: "vitality-whitening",
      treatment: "whitening",
      variants: {
        // Variant A leads on the outcome (a brighter smile). No price in the headline.
        a: {
          heroHeadline: "A brighter smile, guided by a dentist",
          heroAccent: "brighter smile",
          heroSubhead:
            "Professional teeth whitening at Vitality Dental, a dentist led way to lift everyday staining and brighten your natural teeth, at home, in the chair, or both.",
          ctaLabel: "Book my free consultation",
        },
        // Variant B is the price objection-breaker: it leads on the entry price + 0%
        // finance (the cost objection), against the outcome-led A.
        b: {
          heroHeadline: "Whiten your teeth from £350, with 0% finance",
          heroAccent: "0% finance",
          heroSubhead:
            "Professional teeth whitening at Vitality Dental, planned around the shade you would like. Spread the cost with 0% finance, and book a free, unhurried consultation.",
          ctaLabel: "Check if whitening suits me",
        },
      },
    },
    // Veneers (seeded DRAFT). Same machinery + the shared bespoke renderer. Veneers
    // have finance, so variant b leads on the entry price + 0% finance.
    veneers: {
      templateId: "vitality-veneers",
      treatment: "veneers",
      variants: {
        // Variant A leads on the outcome (reshaping the smile). No price in the headline.
        a: {
          heroHeadline: "Reshape your smile with custom veneers",
          heroAccent: "custom veneers",
          heroSubhead:
            "Veneers at Vitality Dental, thin covers shaped and bonded to the front of your teeth to improve their shape and colour, for a natural looking smile.",
          ctaLabel: "Book my free consultation",
        },
        // Variant B is the price objection-breaker: it leads on the entry price + 0% finance.
        b: {
          heroHeadline: "Custom veneers from £450, with 0% finance",
          heroAccent: "0% finance",
          heroSubhead:
            "Custom made veneers at Vitality Dental, designed around your natural features to improve the shape and colour of your teeth. Spread the cost with 0% finance.",
          ctaLabel: "Check if veneers suit me",
        },
      },
    },
    // Dental implant (seeded DRAFT). Same machinery + the shared bespoke renderer.
    // Implants have finance; variant b leads on the entry price + 0% finance. Claims
    // stay modest: "a long lasting way to replace a missing tooth" (catalogue phrasing).
    implant: {
      templateId: "vitality-implant",
      treatment: "implant",
      variants: {
        // Variant A leads on the outcome (replacing a missing tooth). No price in the headline.
        a: {
          heroHeadline: "A long lasting way to replace a missing tooth",
          heroAccent: "replace a missing tooth",
          heroSubhead:
            "Dental implants at Vitality Dental, a small fixture that supports a natural looking crown, fixed in place to fill the gap without relying on the teeth around it.",
          ctaLabel: "Book my free consultation",
        },
        // Variant B is the price objection-breaker: it leads on the entry price + 0% finance.
        b: {
          heroHeadline: "Replace a missing tooth from £2,400, with 0% finance",
          heroAccent: "0% finance",
          heroSubhead:
            "Dental implants at Vitality Dental, a long lasting way to replace a missing tooth with a natural looking crown. Spread the cost with 0% finance, and book a free consultation.",
          ctaLabel: "Check if an implant suits me",
        },
      },
    },
    // Routine checkup (seeded DRAFT). Same machinery + the shared bespoke renderer.
    // Checkup has NO finance, so neither variant carries finance wording; variant b is
    // still price-led (the real catalogue price in the headline), just without finance.
    checkup: {
      templateId: "vitality-checkup",
      treatment: "checkup",
      variants: {
        // Variant A leads on the outcome (a healthy smile). No price in the headline.
        a: {
          heroHeadline: "A healthy smile starts with a checkup",
          heroAccent: "a checkup",
          heroSubhead:
            "A routine dental checkup with the dentist at Vitality Dental. We check your teeth and gums, catch anything early, and keep your smile healthy.",
          ctaLabel: "Book my checkup",
        },
        // Variant B is the price objection-breaker: it leads on the flat checkup price
        // (the cost objection), against the outcome-led A. NO finance (checkup has none).
        b: {
          heroHeadline: "A routine dental checkup, £60",
          heroAccent: "£60",
          heroSubhead:
            "A routine dental checkup with the dentist at Vitality Dental, usually about thirty minutes. We check your teeth and gums and catch anything early.",
          ctaLabel: "Book a checkup appointment",
        },
      },
    },
  },
};

/**
 * The bespoke template for a (clientId, slug), or null when the page uses the
 * generic renderer. Pure string lookup; callers resolve the clientId first.
 */
export function getBespokeTemplate(clientId: string, slug: string): BespokeTemplate | null {
  return BESPOKE_TEMPLATES[clientId]?.[slug] ?? null;
}

/** The per-variant copy for a template, defaulting to variant a for any bad key. */
export function bespokeVariantCopy(
  template: BespokeTemplate,
  variant: "a" | "b",
): BespokeVariantCopy {
  return variant === "b" ? template.variants.b : template.variants.a;
}
