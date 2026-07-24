import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VitalityHygieneLanding } from "./vitality-hygiene-landing";

// Render smoke tests for the bespoke hygiene server component: the analytics markers
// the LandingTracker needs, the per-variant accented headline + CTA, the real
// catalogue price, the interactive before/after SLIDER (both illustration srcs, the
// range input, the verbatim caption), and the compliance omissions (no finance copy,
// no star ratings / reviews, and none of the Invisalign/bonding photos reused here).

function render(variant: "a" | "b"): string {
  return renderToStaticMarkup(
    createElement(VitalityHygieneLanding, {
      variant,
      clientSlug: "vitality",
      landingSlug: "hygiene",
      siteId: "site-cc",
      practiceName: "Vitality Dental",
    }),
  );
}

describe("VitalityHygieneLanding", () => {
  it("emits every section marker the tracker observes, plus tagged CTAs", () => {
    const html = render("a");
    for (const section of [
      "hero",
      "pain_points",
      "treatment",
      "helps",
      "product",
      "before_after",
      "why",
      "pricing",
      "faq",
    ]) {
      expect(html).toContain(`data-lp-section="${section}"`);
    }
    expect(html).toContain("data-lp-cta");
    // CTAs scroll to the embedded form.
    expect(html).toContain('href="#consultation"');
    expect(html).toContain('id="consultation"');
  });

  it("uses the platform logo and authors inline SVG line-icons", () => {
    const html = render("a");
    expect(html).toContain('src="/copilot-logo.png"');
    expect(html).toContain("<svg");
    // Line-icon concern + helps cards render their titles.
    expect(html).toContain("Tea and coffee staining");
    expect(html).toContain("Plaque and tartar");
  });

  it("renders the per-variant accented headline and CTA label", () => {
    const a = render("a");
    expect(a).toContain('<span class="acc">fresher, cleaner</span>');
    expect(a).toContain("Book my hygiene visit");

    const b = render("b");
    expect(b).toContain('<span class="acc">£75</span>');
    expect(b).toContain("Book my scale and polish");
  });

  it("shows the real catalogue price and the consent checkbox copy", () => {
    const html = render("a");
    expect(html).toContain("£75");
    expect(html).toContain("I agree to be contacted about my enquiry.");
  });

  it("renders the before/after slider: both illustration srcs, the range input and the verbatim caption", () => {
    const html = render("a");
    expect(html).toContain('src="/landing/hygiene/smile-before.png"');
    expect(html).toContain('src="/landing/hygiene/smile-after.png"');
    // The a11y range with its aria-label.
    expect(html).toContain('type="range"');
    expect(html).toContain('aria-label="Drag to compare before and after"');
    // The clip-path inset that reveals the before image (starts at 50).
    expect(html).toContain("clip-path");
    // Before/After pill labels.
    expect(html).toContain(">Before<");
    expect(html).toContain(">After<");
    // The caption is verbatim and makes clear this is an illustration, not a photo.
    expect(html).toContain("Drag to compare. Illustrative model, not a patient photo.");
  });

  it("shows the product band image (not a placeholder)", () => {
    const html = render("a");
    expect(html).toContain('src="/landing/hygiene/fresh-smile.jpg"');
    expect(html).toContain("A clean you can feel");
  });

  it("carries NO finance copy anywhere (hygiene has no finance)", () => {
    // NB: scan for finance-specific wording, not a bare "0%" (that substring also
    // occurs inside CSS lengths like "100%").
    const html = render("a").toLowerCase();
    expect(html).not.toContain("finance");
    expect(html).not.toContain("0% finance");
    expect(html).not.toContain("0 percent");
    expect(html).not.toContain("interest-free");
    expect(html).not.toContain("spread the cost");
  });

  it("does NOT reuse any Invisalign or bonding photo asset", () => {
    const html = render("a");
    expect(html).not.toContain("/landing/invisalign/");
    expect(html).not.toContain("/landing/bonding/");
    expect(html).not.toContain("conditions/");
    expect(html).not.toContain("before-after/case-");
  });

  it("omits every fabricated proof element (stars, ratings, reviews wall)", () => {
    const html = render("a");
    expect(html).not.toContain("★");
    expect(html).not.toContain("Google rating");
    expect(html).not.toContain("Google review");
    expect(html).not.toContain("What our patients say");
  });
});
