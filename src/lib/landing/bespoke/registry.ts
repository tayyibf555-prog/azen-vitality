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
// THE A/B SURFACE. Only four things differ between variant a and b: the hero
// headline, the hero accent (a verbatim substring of the headline, highlighted in
// brand blue by the renderer), the hero subhead, and the primary CTA label.
// Everything else in the design is identical across variants.
//
// COMPLIANCE: every string below is scanned by scanBannedText in the registry
// test (British English, no dashes, no testimonials/superlatives/funding words).

/** The per-variant hero + CTA copy: the only thing that differs a vs b. */
export interface BespokeVariantCopy {
  /** Full hero headline. */
  heroHeadline: string;
  /** A verbatim (case-insensitive) substring of heroHeadline to accent in blue. */
  heroAccent: string;
  /** Supporting hero paragraph. */
  heroSubhead: string;
  /** Primary CTA label (header button, pricing button, and the form submit). */
  ctaLabel: string;
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
          heroHeadline: "Straighter teeth, no metal braces, from 3 months",
          heroAccent: "from 3 months",
          heroSubhead:
            "Invisalign clear aligners at Vitality Dental. Virtually invisible, fully removable, and planned around your life. A confident, straighter smile without a single wire.",
          ctaLabel: "Book my free consultation",
        },
        // Variant B leads on the method (clear aligners) and a suitability CTA.
        b: {
          heroHeadline: "A straighter smile with clear aligners",
          heroAccent: "clear aligners",
          heroSubhead:
            "A discreet way to straighten your teeth at Vitality Dental, with a free initial consultation and a friendly, unrushed team. No brackets, no wires, no one needs to know.",
          ctaLabel: "Check if I am suitable",
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
        // Variant B leads on the concern (chips and gaps) with minimal preparation.
        b: {
          heroHeadline: "Fix chips and gaps with minimal preparation",
          heroAccent: "minimal preparation",
          heroSubhead:
            "A quick, gentle way to reshape your teeth at Vitality Dental. Composite bonding smooths chips and closes small gaps with minimal preparation, plus a free initial consultation.",
          ctaLabel: "Check if bonding suits me",
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
        // Variant B leads on gum health (the reason to keep on top of a clean).
        b: {
          heroHeadline: "Healthier gums start with a professional clean",
          heroAccent: "professional clean",
          heroSubhead:
            "A gentle, thorough hygiene visit at Vitality Dental. Removing built up plaque and tartar helps keep your gums healthy, and your smile feeling fresh.",
          ctaLabel: "Book a hygiene appointment",
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
