import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VitalityInvisalignLanding } from "./vitality-invisalign-landing";

// Render smoke tests for the bespoke server component: the analytics markers the
// LandingTracker needs, the self-hosted asset paths, the per-variant accented
// headline, and the compliance omissions (no star ratings, review wall or
// fabricated Google-rating stat reach the DOM).

function render(variant: "a" | "b"): string {
  return renderToStaticMarkup(
    createElement(VitalityInvisalignLanding, {
      variant,
      clientSlug: "vitality",
      landingSlug: "invisalign",
      siteId: "site-cc",
      practiceName: "Vitality Dental",
    }),
  );
}

describe("VitalityInvisalignLanding", () => {
  it("emits every section marker the tracker observes, plus tagged CTAs", () => {
    const html = render("a");
    for (const section of [
      "hero",
      "stories",
      "pain_points",
      "treatment",
      "conditions",
      "before_after",
      "why",
      "pricing",
    ]) {
      expect(html).toContain(`data-lp-section="${section}"`);
    }
    expect(html).toContain("data-lp-cta");
    // CTAs scroll to the embedded form.
    expect(html).toContain('href="#consultation"');
    expect(html).toContain('id="consultation"');
  });

  it("uses the self-hosted asset paths for logo, conditions, patients and before/after", () => {
    const html = render("a");
    expect(html).toContain('src="/copilot-logo.png"');
    expect(html).toContain('src="/landing/invisalign/conditions/crowded.png"');
    expect(html).toContain('src="/landing/invisalign/conditions/crossbite.png"');
    expect(html).toContain('src="/landing/invisalign/patients/story-1.jpg"');
    expect(html).toContain('src="/landing/invisalign/before-after/case-3.jpg"');
  });

  it("renders the per-variant accented headline and CTA label", () => {
    const a = render("a");
    expect(a).toContain('<span class="acc">clear aligners</span>');
    expect(a).toContain("Book my free consultation");

    const b = render("b");
    expect(b).toContain('<span class="acc">0% finance</span>');
    expect(b).toContain("Book my free consultation");
  });

  it("shows the real catalogue price and the consent checkbox copy", () => {
    const html = render("a");
    expect(html).toContain("£2,500");
    expect(html).toContain("0% finance available");
    expect(html).toContain("I agree to be contacted about my enquiry.");
    expect(html).toContain("shown with their written consent"); // before/after disclaimer kept
  });

  it("omits every fabricated proof element (stars, ratings, reviews wall)", () => {
    const html = render("a");
    expect(html).not.toContain("★");
    expect(html).not.toContain("Google rating");
    expect(html).not.toContain("Google review");
    expect(html).not.toContain("What our patients say");
    // The fabricated hero "star rating" trust stat is gone (the "★" + "Google
    // rating" checks above pin this; a bare number check would false-match SVG path
    // coordinates like the shield icon's "v4.9").
  });
});
