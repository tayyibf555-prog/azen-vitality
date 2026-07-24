import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VitalityWhiteningLanding } from "./vitality-whitening-landing";

// Render smoke tests for the bespoke whitening server component (rendered via the shared
// StandardTreatmentLanding): the analytics markers the LandingTracker needs, the
// per-variant accented headline + CTA, the real catalogue price, the finance chip (0%
// finance is offered), the LABELLED placeholder slots (no real photos yet), and the
// compliance omissions (no star ratings / reviews, and no Invisalign/bonding photos).

function render(variant: "a" | "b"): string {
  return renderToStaticMarkup(
    createElement(VitalityWhiteningLanding, {
      variant,
      clientSlug: "vitality",
      landingSlug: "whitening",
      siteId: "site-cc",
      practiceName: "Vitality Dental",
    }),
  );
}

describe("VitalityWhiteningLanding", () => {
  it("emits every section marker the tracker observes, plus tagged CTAs", () => {
    const html = render("a");
    for (const section of [
      "hero",
      "pain_points",
      "treatment",
      "helps",
      "stories",
      "before_after",
      "why",
      "pricing",
      "faq",
    ]) {
      expect(html).toContain(`data-lp-section="${section}"`);
    }
    expect(html).toContain("data-lp-cta");
    expect(html).toContain('href="#consultation"');
    expect(html).toContain('id="consultation"');
  });

  it("uses the platform logo and authors inline SVG line-icons", () => {
    const html = render("a");
    expect(html).toContain('src="/copilot-logo.png"');
    expect(html).toContain("<svg");
    expect(html).toContain("Tea, coffee and red wine");
    expect(html).toContain("Everyday staining");
  });

  it("renders the per-variant accented headline and CTA label", () => {
    const a = render("a");
    expect(a).toContain('<span class="acc">brighter smile</span>');
    expect(a).toContain("Book my free consultation");

    const b = render("b");
    expect(b).toContain('<span class="acc">0% finance</span>');
    expect(b).toContain("Check if whitening suits me");
  });

  it("shows the real catalogue price, the finance chip and the consent checkbox copy", () => {
    const html = render("a");
    expect(html).toContain("£350");
    expect(html).toContain("0% finance available");
    expect(html).toContain("I agree to be contacted about my enquiry.");
  });

  it("renders LABELLED placeholder slots and keeps the before/after consent disclaimer", () => {
    const html = render("a");
    expect(html).toContain("Your consented whitening result here");
    expect(html).toContain("shown with their written consent");
  });

  it("does NOT reuse any Invisalign, bonding or hygiene photo asset", () => {
    const html = render("a");
    expect(html).not.toContain("/landing/invisalign/");
    expect(html).not.toContain("/landing/bonding/");
    expect(html).not.toContain("/landing/hygiene/");
    expect(html).not.toContain("conditions/");
  });

  it("omits every fabricated proof element (stars, ratings, reviews wall)", () => {
    const html = render("a");
    expect(html).not.toContain("★");
    expect(html).not.toContain("Google rating");
    expect(html).not.toContain("Google review");
    expect(html).not.toContain("What our patients say");
  });
});
