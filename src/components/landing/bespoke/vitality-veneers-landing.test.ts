import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VitalityVeneersLanding } from "./vitality-veneers-landing";

// Render smoke tests for the bespoke veneers server component (rendered via the shared
// StandardTreatmentLanding): the analytics markers, the per-variant accented headline +
// CTA, the real catalogue price, the finance chip (0% finance is offered), the LABELLED
// placeholder slots, and the compliance omissions.

function render(variant: "a" | "b"): string {
  return renderToStaticMarkup(
    createElement(VitalityVeneersLanding, {
      variant,
      clientSlug: "vitality",
      landingSlug: "veneers",
      siteId: "site-cc",
      practiceName: "Vitality Dental",
    }),
  );
}

describe("VitalityVeneersLanding", () => {
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
    expect(html).toContain("Teeth that look worn");
    expect(html).toContain("Shape and proportion");
  });

  it("renders the per-variant accented headline and CTA label", () => {
    const a = render("a");
    expect(a).toContain('<span class="acc">custom veneers</span>');
    expect(a).toContain("Book my free consultation");

    const b = render("b");
    expect(b).toContain('<span class="acc">0% finance</span>');
    expect(b).toContain("Check if veneers suit me");
  });

  it("shows the real catalogue price, the finance chip and the consent checkbox copy", () => {
    const html = render("a");
    expect(html).toContain("£450");
    expect(html).toContain("0% finance available");
    expect(html).toContain("I agree to be contacted about my enquiry.");
  });

  it("renders LABELLED placeholder slots and keeps the before/after consent disclaimer", () => {
    const html = render("a");
    expect(html).toContain("Your consented veneer case here");
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
