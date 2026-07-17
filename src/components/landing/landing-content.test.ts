import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LandingContent } from "./landing-content";
import { validateContent, type LandingPageContent } from "@/lib/landing/content";
import { goodContent } from "@/lib/landing/test-fixtures";
import type { PracticeFacts } from "@/lib/types";

// Renderer smoke tests. LandingContent is a PURE server component (no hooks, no
// function props), so it renders under the node test environment with
// renderToStaticMarkup, no jsdom needed. These pin the compliance-critical
// renderer behaviour: proof claims render ONLY from practiceFacts (absent =
// omitted), and the 3D showcase (script included) renders ONLY when the content
// carries an owner-configured showcase3d.

function content(mutate?: (c: LandingPageContent) => void): LandingPageContent {
  const res = validateContent(goodContent());
  if (!res.content) throw new Error("fixture invalid");
  if (mutate) mutate(res.content);
  return res.content;
}

const NO_FACTS: PracticeFacts = {
  googleRating: null,
  reviewCount: null,
  clinicsCount: null,
  locationsLine: null,
  awardsLine: null,
  pressMentions: [],
};

function render(over: Partial<Parameters<typeof LandingContent>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(LandingContent, {
      content: content(),
      practiceName: "Vitality Dental",
      clientSlug: "vitality",
      landingSlug: "invisalign-demo",
      variant: "a",
      siteId: "site-cc",
      practiceFacts: null,
      treatmentName: "Invisalign",
      ...over,
    }),
  );
}

describe("LandingContent (v2 renderer)", () => {
  it("renders every v2 section with anchors and the accented headline", () => {
    const html = render();
    // Section markers for the scroll-depth tracker.
    for (const section of ["hero", "pain_points", "about", "how_it_works", "suitability", "pricing", "faq", "final_cta"]) {
      expect(html).toContain(`data-lp-section="${section}"`);
    }
    // Topbar CTA anchors to the hero CTA block.
    expect(html).toContain('href="#lp-cta"');
    expect(html).toContain('id="lp-cta"');
    // The accent phrase is highlighted in brand blue within the headline.
    expect(html).toContain('<span class="text-blue-royal">from 3 months</span>');
    // Copy from each section reaches the DOM.
    expect(html).toContain("Sound familiar?");
    expect(html).toContain("What is Invisalign?");
    expect(html).toContain("What Invisalign can help with");
    expect(html).toContain("from £2,500");
    // Attribution-tagged CTA link into the assessment funnel.
    expect(html).toContain("data-lp-cta");
    expect(html).toContain("/assess/vitality?lpv=a");
  });

  describe("practiceFacts gating (proof claims are owner-verified only)", () => {
    it("omits the proof row entirely when facts are absent or all-null", () => {
      const noFacts = render({ practiceFacts: null });
      expect(noFacts).not.toContain("Google rating");
      expect(noFacts).not.toContain("Google reviews");
      expect(noFacts).not.toContain("As seen in");

      const nullFacts = render({ practiceFacts: NO_FACTS });
      expect(nullFacts).not.toContain("Google rating");
      expect(nullFacts).not.toContain("clinics"); // "clinical assessment" copy stays
      expect(nullFacts).not.toContain("As seen in");
    });

    it("renders exactly the supplied facts when present", () => {
      const html = render({
        practiceFacts: {
          googleRating: 4.9,
          reviewCount: 1234,
          clinicsCount: 3,
          locationsLine: "N15, N17 and Romford Road, London",
          awardsLine: null,
          pressMentions: [],
        },
      });
      expect(html).toContain("4.9");
      expect(html).toContain("Google rating");
      expect(html).toContain("1,234");
      expect(html).toContain("Google reviews");
      expect(html).toContain("clinics");
      expect(html).toContain("N15, N17 and Romford Road, London");
      // Unset facts stay omitted even when others render.
      expect(html).not.toContain("As seen in");
    });

    it("renders a partial facts object without the missing stats", () => {
      const html = render({
        practiceFacts: { ...NO_FACTS, clinicsCount: 3 },
      });
      expect(html).toContain("clinics");
      expect(html).not.toContain("Google rating");
      expect(html).not.toContain("Google reviews");
    });

    it("renders the awards line and press mentions ONLY from facts", () => {
      const html = render({
        practiceFacts: {
          ...NO_FACTS,
          awardsLine: "Dental Industry Awards finalist 2025",
          pressMentions: ["The Example Times"],
        },
      });
      expect(html).toContain("Dental Industry Awards finalist 2025");
      expect(html).toContain("As seen in The Example Times");
    });
  });

  describe("3D showcase (owner-configured only)", () => {
    it("omits the section AND the vendored script when no showcase is configured", () => {
      const html = render();
      expect(html).not.toContain("model-viewer");
      expect(html).not.toContain("/vendor/model-viewer/model-viewer.min.js");
      expect(html).not.toContain('data-lp-section="showcase"');
    });

    it("renders the viewer + loads the vendored script only when configured", () => {
      const withShowcase = content((c) => {
        c.showcase3d = {
          modelUrl: "/models/aligner.glb",
          posterUrl: "/models/aligner.webp",
          caption: "Explore a clear aligner up close.",
        };
      });
      const html = render({ content: withShowcase });
      expect(html).toContain('data-lp-section="showcase"');
      expect(html).toContain("<model-viewer");
      expect(html).toContain('src="/models/aligner.glb"');
      expect(html).toContain('poster="/models/aligner.webp"');
      expect(html).toContain("auto-rotate");
      expect(html).toContain('loading="lazy"');
      expect(html).toContain('src="/vendor/model-viewer/model-viewer.min.js"');
      // Reduced-motion visitors get the rotation stripped by the inline guard.
      expect(html).toContain("prefers-reduced-motion");
      // Fallback poster image inside the element (shows when JS/script fails).
      expect(html).toContain("Explore a clear aligner up close.");
    });

    it("renders only the static poster in dashboard preview mode (no script)", () => {
      const withShowcase = content((c) => {
        c.showcase3d = {
          modelUrl: "/models/aligner.glb",
          posterUrl: "/models/aligner.webp",
          caption: "Explore a clear aligner up close.",
        };
      });
      const html = render({ content: withShowcase, preview: true });
      expect(html).not.toContain("<model-viewer");
      expect(html).not.toContain("/vendor/model-viewer/model-viewer.min.js");
      expect(html).toContain('src="/models/aligner.webp"');
    });
  });

  it("preview mode renders CTAs as inert spans (no links, no attribution)", () => {
    const html = render({ preview: true });
    expect(html).not.toContain("data-lp-cta");
    expect(html).not.toContain("/assess/vitality");
    // The CTA label still shows so the preview looks real.
    expect(html).toContain("Check your options");
  });

  it("carries the GDC suitability footer line", () => {
    expect(render()).toContain("Treatment suitability always depends");
  });
});
