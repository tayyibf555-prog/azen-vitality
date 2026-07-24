import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VitalityImplantLanding } from "./vitality-implant-landing";

// Render smoke tests for the bespoke implant server component (rendered via the shared
// StandardTreatmentLanding): the analytics markers, the per-variant accented headline +
// CTA, the real catalogue price, the finance chip (0% finance is offered), the LABELLED
// placeholder slots, and the compliance omissions. Claims stay modest ("a long lasting
// way to replace a missing tooth", never "permanent").

function render(variant: "a" | "b"): string {
  return renderToStaticMarkup(
    createElement(VitalityImplantLanding, {
      variant,
      clientSlug: "vitality",
      landingSlug: "implant",
      siteId: "site-cc",
      practiceName: "Vitality Dental",
    }),
  );
}

describe("VitalityImplantLanding", () => {
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
    expect(html).toContain("A gap when you smile");
    expect(html).toContain("A single missing tooth");
  });

  it("renders the per-variant accented headline and CTA label", () => {
    const a = render("a");
    expect(a).toContain('<span class="acc">replace a missing tooth</span>');
    expect(a).toContain("Book my free consultation");

    const b = render("b");
    expect(b).toContain('<span class="acc">0% finance</span>');
    expect(b).toContain("Check if an implant suits me");
  });

  it("shows the real catalogue price, the finance chip and the consent checkbox copy", () => {
    const html = render("a");
    expect(html).toContain("£2,400");
    expect(html).toContain("0% finance available");
    expect(html).toContain("I agree to be contacted about my enquiry.");
  });

  it("keeps claims modest: uses long-lasting phrasing, never 'permanent'", () => {
    const html = render("a").toLowerCase();
    expect(html).toContain("long lasting way to replace a missing tooth");
    expect(html).not.toContain("permanent");
  });

  it("renders LABELLED placeholder slots and keeps the before/after consent disclaimer", () => {
    const html = render("a");
    expect(html).toContain("Your consented implant case here");
    expect(html).toContain("shown with their written consent");
  });

  it("omits every fabricated proof element (stars, ratings, reviews wall)", () => {
    const html = render("a");
    expect(html).not.toContain("★");
    expect(html).not.toContain("Google rating");
    expect(html).not.toContain("Google review");
    expect(html).not.toContain("What our patients say");
  });
});
