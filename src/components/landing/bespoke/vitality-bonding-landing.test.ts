import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VitalityBondingLanding } from "./vitality-bonding-landing";

// Render smoke tests for the bespoke bonding server component: the analytics markers
// the LandingTracker needs, the per-variant accented headline, the real catalogue
// price, the LABELLED placeholder slots (no real bonding photos yet), and the
// compliance omissions (no star ratings / reviews wall, and crucially none of the
// Invisalign photos are reused here).

function render(variant: "a" | "b"): string {
  return renderToStaticMarkup(
    createElement(VitalityBondingLanding, {
      variant,
      clientSlug: "vitality",
      landingSlug: "bonding",
      siteId: "site-cc",
      practiceName: "Vitality Dental",
    }),
  );
}

describe("VitalityBondingLanding", () => {
  it("emits every section marker the tracker observes, plus tagged CTAs", () => {
    const html = render("a");
    for (const section of [
      "hero",
      "fixes",
      "treatment",
      "benefits",
      "suitability",
      "stories",
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

  it("uses the platform logo and authors inline SVG line-icons (no 3D model PNGs)", () => {
    const html = render("a");
    expect(html).toContain('src="/copilot-logo.png"');
    // The fixes grid is line-icon cards, authored inline.
    expect(html).toContain("<svg");
    expect(html).toContain("Chipped teeth");
    expect(html).toContain("Gaps and spacing");
  });

  it("does NOT reuse any Invisalign photo asset", () => {
    const html = render("a");
    expect(html).not.toContain("/landing/invisalign/");
    expect(html).not.toContain("conditions/");
    expect(html).not.toContain("before-after/case-");
    expect(html).not.toContain("patients/story-");
  });

  it("renders the per-variant accented headline and CTA label", () => {
    const a = render("a");
    expect(a).toContain('<span class="acc">a single visit</span>');
    expect(a).toContain("Book my free consultation");

    const b = render("b");
    expect(b).toContain('<span class="acc">from £180</span>');
    expect(b).toContain("Book my free bonding consultation");
  });

  it("shows the real catalogue price and the consent checkbox copy", () => {
    const html = render("a");
    expect(html).toContain("£180");
    expect(html).toContain("0% finance available");
    expect(html).toContain("I agree to be contacted about my enquiry.");
  });

  it("renders LABELLED placeholder slots and keeps the before/after consent disclaimer", () => {
    const html = render("a");
    expect(html).toContain("Your consented bonding case here");
    expect(html).toContain("shown with their written consent"); // before/after disclaimer kept
  });

  it("omits every fabricated proof element (stars, ratings, reviews wall)", () => {
    const html = render("a");
    expect(html).not.toContain("★");
    expect(html).not.toContain("Google rating");
    expect(html).not.toContain("Google review");
    expect(html).not.toContain("What our patients say");
  });
});
